import {
  type AutomergeUrl,
  type DocHandle,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type Repo,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import {
  importPackageFromFolderDocUrl,
  importPackageFromHttpUrl,
} from "./packages.js";
import { type HasPatchworkMetadata } from "./metadata.js";
import type { PackageEntry } from "./packages-folder.js";
import {
  DEFAULT_BRANCH,
  trackPackagesInRepo,
  type PackageTracker,
} from "./package-tracker.js";
import debug from "debug";

const log = debug("patchwork:modules");

export type ModuleSettingsDoc = {
  modules: AutomergeUrl[];
} & HasPatchworkMetadata & {
    "@patchwork": { type: "patchwork:module-settings" };
  };

// A single pushwork sync commits a burst of changes to a package's doc — the
// file-list write, an optional pin refresh, and a trailing `lastSyncAt` stamp —
// and the file docs it references sync as independent documents. Coalesce that
// burst into one reload by waiting for the package doc's heads to stop moving
// for this long before re-importing, so we pin to the settled, consistent
// snapshot instead of an intermediate one.
const RELOAD_DEBOUNCE_MS = 250;

// A package can fail to import just because the automerge worker serving its
// files is still coming up. Nothing else brings it back — setDocWatcher only
// fires when the package doc's own heads move — so back off and try again.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

function getDocumentBaseUrl(): string {
  // `document.baseURI` is the document's proper base URL — for a srcdoc/sandboxed
  // frame that's the embedder's URL (a valid base), where `location.href` would
  // be "about:srcdoc" (invalid). Falls back to location for non-document realms.
  return (
    globalThis.document?.baseURI ??
    globalThis.location?.href ??
    "http://localhost/"
  );
}

/**
 * Relative (non-Automerge) module URLs are
 * resolved against the manifest's own URL so they can be dynamically imported
 * regardless of where the watcher code itself lives.
 */
async function fetchModuleManifest(url: string): Promise<ModuleSettingsDoc> {
  const manifestUrl = new URL(url, getDocumentBaseUrl()).href;
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch module manifest ${manifestUrl}: ${response.status}`
    );
  }
  const json = (await response.json()) as Partial<ModuleSettingsDoc>;
  const modules = (Array.isArray(json.modules) ? json.modules : []).map(
    (moduleUrl) =>
      isValidAutomergeUrl(moduleUrl)
        ? moduleUrl
        : (new URL(moduleUrl, manifestUrl).href as AutomergeUrl)
  );
  return {
    "@patchwork": { type: "patchwork:module-settings" },
    modules,
  } as ModuleSettingsDoc;
}

type WatchedModule = {
  /** The package doc being watched: a branches doc's is its default branch. */
  packageUrl: AutomergeUrl;
  unwatch: () => void;
  onChange: (seen?: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** The url at heads this watch takes to be current. */
  version?: string;
  /** What the tracker last said it holds of the package doc. */
  seen?: string;
  /** The first lookup only sets `version`, rather than reloading. */
  baseline: boolean;
  /** Bumped per lookup, so only the newest one's answer is acted on. */
  lookups: number;
  /** A change-triggered lookup is in flight. */
  looking: boolean;
  /** A change landed while `looking`, so look again once it's back. */
  stale: boolean;
};

/** The url of the document `url` names, without heads. */
const stripHeads = (url: AutomergeUrl) =>
  stringifyAutomergeUrl({ documentId: parseAutomergeUrl(url).documentId });

function warnBranchesUnsupported(branchesDocUrl: AutomergeUrl) {
  console.warn(
    `module ${branchesDocUrl} is a branches doc. Branches docs are no longer supported as modules; falling back to the "${DEFAULT_BRANCH}" branch. Please let us know you hit this: post in #patchwork-testers or email chee@inkandswitch.com`
  );
}

// todo this can be a function that takes a plugin system and returns a change
// handler

/**
 * Settings sources are passed in keyed by name (e.g. `{ system, user }`). Each
 * source URL may be either an Automerge module-settings doc (`automerge:...`,
 * live-reloaded) or an HTTP(S) URL to a static JSON manifest of the same shape
 * (fetched once at construction). The two kinds can be freely mixed, and the
 * module URLs *within* either kind can themselves point at Automerge package
 * docs (folders or directories) or plain HTTP(S) bundles.
 */
export class ModuleWatcher {
  repo: Repo;
  urls: Record<string, string>;
  handles: Record<string, DocHandle<ModuleSettingsDoc>> | undefined;
  staticManifests: Record<string, ModuleSettingsDoc> = {};
  doneLoading: Promise<void>;
  #watchedModules = new Map<string, WatchedModule>();
  // Per-module announce generation. Bumped whenever a newer announce starts
  // for the same module, so a stale retry chain (still backing off from a
  // failed import of an older pinned version) abandons itself instead of
  // eventually succeeding and rolling the registry back to that old version.
  #announceGenerations = new Map<string, number>();
  #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Lookups that failed, waiting to try again. */
  #lookupRetries = new Map<string, ReturnType<typeof setTimeout>>();
  #lastAnnounced = new Map<string, string>();
  #activeModules = new Set<string>();
  /** Package folders (`/packages`), by source name: what they list, and how to stop hearing them. */
  #folders = new Map<
    string,
    { entries: () => PackageEntry[]; unsubscribe: () => void }
  >();
  #disposed = false;

  onLoad: (name: string, mod: any) => void;
  onUnload?: (name: string) => void;
  /**
   * How an Automerge package doc (pinned to heads) is turned into the
   * `{ plugins }` shape `onLoad` consumes. Defaults to importing the package
   * entry point directly on this thread. The browser bootloader overrides this
   * to run the entry point in a worker for descriptor discovery and rebuild the
   * `{ plugins }` shape with main-thread `load()` functions.
   */
  importAutomergePackage: (urlAtHeads: string) => Promise<any>;
  /**
   * How a package's doc is looked up at its latest heads and watched for new
   * ones. Defaults to holding each package doc in `repo`. The browser setup
   * passes {@link trackPackagesViaServiceWorker}, looking them up through the
   * service worker and watching them in `repo`.
   */
  tracker: PackageTracker;

  constructor(
    repo: Repo,
    urls: Record<string, string>,
    callback: (name: string, mod: any) => void,
    onUnload?: (name: string) => void,
    importAutomergePackage: (urlAtHeads: string) => Promise<any> = (url) =>
      importPackageFromFolderDocUrl(url as AutomergeUrl),
    tracker: PackageTracker = trackPackagesInRepo(repo)
  ) {
    this.repo = repo;
    this.urls = { ...urls };
    this.onLoad = callback;
    this.onUnload = onUnload;
    this.importAutomergePackage = importAutomergePackage;
    this.tracker = tracker;
    this.doneLoading = this.init();
  }

  onChange = () => this.load().catch(console.error);

  private async init() {
    const entries = Object.entries(this.urls);
    const settled = await Promise.allSettled(
      entries.map(async ([name, url]) => {
        if (isValidAutomergeUrl(url)) {
          const handle = await this.repo.find<ModuleSettingsDoc>(url);
          return { kind: "automerge", name, handle } as const;
        }
        const manifest = await fetchModuleManifest(url);
        return { kind: "manifest", name, manifest } as const;
      })
    );

    this.handles = {};
    for (const [index, result] of settled.entries()) {
      if (result.status !== "fulfilled") {
        const [name, url] = entries[index];
        console.warn(
          `module settings source "${name}" (${url}) failed to load; skipping`,
          result.reason
        );
        continue;
      }
      const value = result.value;
      if (value.kind === "automerge") {
        this.handles[value.name] = value.handle;
        if (!this.#disposed) value.handle.addListener("change", this.onChange);
      } else {
        this.staticManifests[value.name] = value.manifest;
      }
    }
    if (this.#disposed) return;
    await this.load();
  }

  private settingsDocs(): Array<{
    name: string;
    doc: ModuleSettingsDoc | undefined;
  }> {
    const docs: Array<{ name: string; doc: ModuleSettingsDoc | undefined }> =
      [];
    for (const [name, handle] of Object.entries(this.handles ?? {})) {
      docs.push({ name, doc: handle.doc() });
    }
    for (const [name, manifest] of Object.entries(this.staticManifests)) {
      docs.push({ name, doc: manifest });
    }
    return docs;
  }

  async loadModules(modules: string[]) {
    await Promise.all(
      modules.map(async (importName) => {
        try {
          await this.processModuleEntry(importName);
        } catch (error) {
          console.error(
            new Error(`Failed to load module ${importName}: ${error}`, {
              cause: error,
            })
          );
        }
      })
    );
  }

  private async processModuleEntry(importName: string, attempt = 0) {
    if (isValidAutomergeUrl(importName)) {
      // Watch before looking up, so a change landing in between still reloads.
      // Keyed by the settings entry, a branches doc's included, so removing
      // it from settings unloads this module.
      const watched = this.#watchedModules.get(importName);
      // Already found: its watch looks it up again when it moves. Looking up
      // every package whenever its source's list changes would reload them.
      if (watched?.version !== undefined) return;
      const entry = this.watchPackage(importName, stripHeads(importName));
      if (!entry) return;
      let latest: AutomergeUrl | undefined;
      try {
        latest = await this.findLatestVersion(importName, entry);
      } catch (error) {
        // Nothing else brings it back until the package moves: back off and
        // look again.
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(
          `couldn't look up ${importName}${delay === undefined ? "" : `; trying again in ${delay}ms`}`,
          error
        );
        if (delay !== undefined) {
          const timer = setTimeout(() => {
            this.#lookupRetries.delete(importName);
            if (this.#activeModules.has(importName)) {
              void this.processModuleEntry(importName, attempt + 1);
            }
          }, delay);
          this.#lookupRetries.set(importName, timer);
        }
        return;
      }
      // A newer lookup took over, and announces what it finds.
      if (!latest) return;
      entry.version = latest;
      if (this.#lastAnnounced.get(importName) === latest) return;
      await this.announce(latest, importName, latest);
      return;
    }
    this.setDocWatcher(importName);
    if (this.#lastAnnounced.has(importName)) return;
    await this.announce(importName);
  }

  private async importPackageSafe(importName: string): Promise<any> {
    try {
      if (isValidAutomergeUrl(importName)) {
        // Pin to heads so descriptor discovery and any later main-thread load
        // resolve against the exact same version of the package doc.
        return await this.importAutomergePackage(
          await this.tracker.findLatest(importName)
        );
      }
      return await importPackageFromHttpUrl(importName);
    } catch (error) {
      console.error(
        `%c Failed to import ${importName}`,
        "color: #000, background: #ffbcef",
        error
      );
      return undefined;
    }
  }

  async addUrl(name: string, url: string): Promise<void> {
    if (this.urls[name] === url) return;
    this.urls[name] = url;
    await this.doneLoading;
    if (this.#disposed) return;
    const replaced = this.handles?.[name];
    if (replaced) replaced.removeListener("change", this.onChange);
    delete this.staticManifests[name];
    if (isValidAutomergeUrl(url)) {
      const handle = await this.repo.find<ModuleSettingsDoc>(url);
      if (this.handles) this.handles[name] = handle;
      handle.addListener("change", this.onChange);
    } else {
      if (this.handles) delete this.handles[name];
      this.staticManifests[name] = await fetchModuleManifest(url);
    }
    await this.load();
  }

  /**
   * Import a module and hand it to `onLoad`, retrying on failure. `moduleKey`
   * is the module's stable identity (the unversioned settings-doc entry);
   * `importUrl` may be a version pinned to heads (the reload path). Starting
   * an announce supersedes any announce still in flight for the same key.
   */
  private async announce(
    importUrl: string,
    moduleKey: string = importUrl,
    versionKey: string = importUrl
  ): Promise<void> {
    const generation = (this.#announceGenerations.get(moduleKey) ?? 0) + 1;
    this.#announceGenerations.set(moduleKey, generation);
    const current = () =>
      this.#announceGenerations.get(moduleKey) === generation;

    const attempt = async (attemptIndex: number): Promise<void> => {
      const mod = await this.importPackageSafe(importUrl);
      // A newer announce for this module started while we were importing or
      // backing off — its result wins; announcing ours now could regress the
      // registry to an older version.
      if (!current()) return;
      if (mod) {
        this.#lastAnnounced.set(moduleKey, versionKey);
        return this.onLoad(importUrl, mod);
      }
      const delay = RETRY_DELAYS_MS[attemptIndex];
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        if (this.#retryTimers.get(moduleKey) === timer) {
          this.#retryTimers.delete(moduleKey);
        }
        if (current()) attempt(attemptIndex + 1).catch(console.error);
      }, delay);
      this.#retryTimers.set(moduleKey, timer);
    };
    await attempt(0);
  }

  // TODO: This is a bit janky and relies on a bunch of heuristics.
  // It would be better to watch all the files in the folder recursively
  // and to have some relationship with those other than just parsing the URL.
  private setDocWatcher(importName: string) {
    // Service-worker module URLs look like `origin/automerge%3A<id>/…` (the
    // encoded automerge URL as the first path segment).
    const encodedId = importName.match(/\/automerge%3A([^/]+)\//i)?.[1];
    const docUrl = encodedId && `automerge:${decodeURIComponent(encodedId)}`;
    if (!docUrl || !isValidAutomergeUrl(docUrl)) return;
    this.watchPackage(importName, stripHeads(docUrl), true);
  }

  /**
   * Reload `importName` when the package doc at `packageUrl` moves to new
   * heads, debounced to the trailing edge so a push's burst of changes
   * collapses into one import at the settled heads. This reacts to real
   * content changes (including offline `save`, which never stamps
   * lastSyncAt) rather than a magic timestamp field. With `baseline`, the
   * current version is looked up now, and only what comes after it reloads.
   */
  private watchPackage(
    importName: string,
    packageUrl: AutomergeUrl,
    baseline = false
  ): WatchedModule | undefined {
    if (this.#disposed) return undefined;
    const watched = this.#watchedModules.get(importName);
    if (watched) return watched;
    const onChange = (seen?: string) => {
      if (seen !== undefined) {
        // The tracker holds what it did: nothing arrived.
        if (seen === entry.seen) return;
        const first = entry.seen === undefined;
        entry.seen = seen;
        // The lookup that settles the version is still to come, and finds
        // whatever this is.
        if (first && entry.version === undefined) return;
      }
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.reloadIfMoved(importName, entry);
      }, RELOAD_DEBOUNCE_MS);
    };
    const entry: WatchedModule = {
      packageUrl,
      onChange,
      unwatch: this.tracker.watch(packageUrl, onChange),
      baseline,
      lookups: 0,
      looking: false,
      stale: false,
    };
    this.#watchedModules.set(importName, entry);
    if (baseline) void this.reloadIfMoved(importName, entry);
    return entry;
  }

  /**
   * Look up the module's latest version, unless a later lookup for it starts
   * meanwhile or it's unloaded. A branches doc is looked up through, since its
   * default branch may have been pointed somewhere else, and the watch moves
   * to whichever doc it names.
   */
  private async findLatestVersion(
    importName: string,
    entry: WatchedModule
  ): Promise<AutomergeUrl | undefined> {
    const lookup = ++entry.lookups;
    const latest = await this.tracker.findLatest(
      isValidAutomergeUrl(importName) ? importName : entry.packageUrl
    );
    if (this.#watchedModules.get(importName) !== entry) return undefined;
    if (lookup !== entry.lookups) return undefined;
    // A /packages package comes back as its pinned /@/ URL, imported over http.
    if (!isValidAutomergeUrl(latest)) return latest;
    const packageUrl = stripHeads(latest);
    if (packageUrl !== entry.packageUrl) {
      warnBranchesUnsupported(importName as AutomergeUrl);
      entry.unwatch();
      entry.packageUrl = packageUrl;
      // What the tracker said it held was of the other doc.
      entry.seen = undefined;
      entry.unwatch = this.tracker.watch(packageUrl, entry.onChange);
    }
    return latest;
  }

  /**
   * One lookup and import at a time per package. A package doc that's still
   * syncing in says it changed with every batch, and a lookup or an import
   * can take as long as the automerge worker's resolve timeout; starting one
   * per change piles them up on a worker that's slow because it's busy.
   * Changes that land meanwhile collapse into one more once this one's back.
   */
  private async reloadIfMoved(importName: string, entry: WatchedModule) {
    if (entry.looking) {
      entry.stale = true;
      return;
    }
    entry.looking = true;
    try {
      do {
        entry.stale = false;
        await this.lookUpAndReload(importName, entry);
      } while (entry.stale && this.#watchedModules.get(importName) === entry);
    } finally {
      entry.looking = false;
    }
  }

  private async lookUpAndReload(importName: string, entry: WatchedModule) {
    let latest: AutomergeUrl | undefined;
    try {
      latest = await this.findLatestVersion(importName, entry);
    } catch (error) {
      console.warn(`couldn't look up the heads of ${importName}`, error);
      return;
    }
    if (!latest || latest === entry.version) return;
    entry.version = latest;
    if (entry.baseline) {
      entry.baseline = false;
      return;
    }
    if (this.#lastAnnounced.get(importName) === latest) return;
    log(`change in ${importName}, reloading at ${latest}`);
    // Keyed by the stable importName so this reload supersedes any
    // still-retrying announce of an older version of the same module.
    await this.announce(latest, importName, latest);
  }

  private detachDocWatcher(importName: string) {
    const watched = this.#watchedModules.get(importName);
    if (!watched) return;
    if (watched.timer) clearTimeout(watched.timer);
    watched.unwatch();
    this.#watchedModules.delete(importName);
  }

  private cancelAnnounce(moduleKey: string) {
    const generation = this.#announceGenerations.get(moduleKey);
    if (generation !== undefined) {
      this.#announceGenerations.set(moduleKey, generation + 1);
    }
    const timer = this.#retryTimers.get(moduleKey);
    if (timer) {
      clearTimeout(timer);
      this.#retryTimers.delete(moduleKey);
    }
  }

  private unloadModule(entry: string) {
    this.detachDocWatcher(entry);
    this.cancelAnnounce(entry);
    clearTimeout(this.#lookupRetries.get(entry));
    this.#lookupRetries.delete(entry);
    // Its plugins were registered under the url it was imported from.
    const announced = this.#lastAnnounced.get(entry);
    this.#lastAnnounced.delete(entry);
    this.onUnload?.(announced ?? entry);
  }

  dispose() {
    this.#disposed = true;
    for (const { unsubscribe } of this.#folders.values()) unsubscribe();
    this.#folders.clear();
    for (const handle of Object.values(this.handles ?? {})) {
      handle.removeListener("change", this.onChange);
    }
    for (const importName of [...this.#watchedModules.keys()]) {
      this.detachDocWatcher(importName);
    }
    for (const [key, generation] of this.#announceGenerations) {
      this.#announceGenerations.set(key, generation + 1);
    }
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    for (const timer of this.#lookupRetries.values()) clearTimeout(timer);
    this.#lookupRetries.clear();
    this.#activeModules.clear();
  }

  /**
   * Load every package in a `/packages` folder, and keep loading what it lists:
   * `subscribe` calls back whenever `entries` may have changed. A package is
   * keyed by its document, so a rename reloads nothing, and one that module
   * settings also lists loads once, through here. Looking packages up is the
   * tracker's job (see trackPackagesFolder).
   */
  async addPackagesFolder(
    name: string,
    entries: () => PackageEntry[],
    subscribe: (onChange: () => void) => () => void
  ): Promise<void> {
    await this.doneLoading;
    if (this.#disposed) return;
    this.#folders.get(name)?.unsubscribe();
    this.#folders.set(name, { entries, unsubscribe: subscribe(this.onChange) });
    await this.load();
  }

  private async load() {
    if (!this.handles) throw new Error("No handles");
    const urls = new Set<string>();
    const inFolders = new Set<string>();
    for (const { entries } of this.#folders.values()) {
      for (const entry of entries()) {
        urls.add(entry.url);
        inFolders.add(parseAutomergeUrl(entry.url).documentId);
      }
    }
    for (const { doc } of this.settingsDocs()) {
      for (const m of doc?.modules ?? []) {
        if (isValidAutomergeUrl(m) && inFolders.has(parseAutomergeUrl(m).documentId)) {
          continue;
        }
        urls.add(m);
      }
    }
    const previousActive = this.#activeModules;
    this.#activeModules = urls;
    for (const previous of previousActive) {
      if (!urls.has(previous)) this.unloadModule(previous);
    }
    await this.loadModules([...urls]);
  }
}
