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

// One pushwork sync is a burst of changes to a package's doc (the file list,
// maybe a pin refresh, a `lastSyncAt` stamp), so wait for its heads to stop
// moving this long, then import the settled snapshot once.
const RELOAD_DEBOUNCE_MS = 250;

// A package can fail to import just because the automerge worker serving its
// files is still coming up. Nothing else brings it back — setDocWatcher only
// fires when the package doc's own heads move — so back off and try again.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

// How long a batch from `prioritize` gets to load what it was expected to,
// from when it opens, before everything still held back is let go. A return
// visit boots in about a second.
const BATCH_TIME_LIMIT_MS = 3_000;

/** A plugin, by the type and id it registers under. */
export type PluginRef = { type: string; id: string };

/**
 * Settings entries to load ahead of the rest, each with the plugins it's
 * expected to provide.
 */
export type LoadBatch = Record<string, PluginRef[]>;

const refKey = (ref: PluginRef) => `${ref.type}\u0000${ref.id}`;

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

type LoadPlan = {
  batches: Map<string, PluginRef[]>[];
  /** How many gates are open. One past the last batch's is the rest's. */
  opened: number;
  /** One per batch, then one for every module in none of them. */
  gates: Gate[];
  timer?: ReturnType<typeof setTimeout>;
  /** What each entry provided, as `refKey`s, once it's loaded. */
  provided: Map<string, Set<string>>;
  /** Entries whose import or lookup failed. */
  failed: Set<string>;
  settle: (held: boolean) => void;
};

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
 * Relative module URLs in a manifest resolve against the manifest's own URL,
 * so they import from wherever this code lives.
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
  /** Lookups that have failed in a row, which pick the next retry's delay. */
  failures: number;
  /** Looks the package up again after a failed lookup. */
  retry?: ReturnType<typeof setTimeout>;
};

/** The url of the document `url` names, without heads. */
const stripHeads = (url: AutomergeUrl) =>
  stringifyAutomergeUrl({ documentId: parseAutomergeUrl(url).documentId });

/**
 * `url`, a service-worker url for a path inside a package, with the package
 * named at `latest` heads. Reloading imports the same file the first load did,
 * and since the url is new, the browser fetches it again.
 */
function pinServiceWorkerUrl(url: string, latest: AutomergeUrl) {
  return url.replace(
    /\/automerge%3A[^/]+\//i,
    `/${encodeURIComponent(latest)}/`
  );
}

function warnBranchesUnsupported(branchesDocUrl: AutomergeUrl) {
  console.warn(
    `module ${branchesDocUrl} is a branches doc. Branches docs are no longer supported as modules; falling back to the "${DEFAULT_BRANCH}" branch. Please let us know you hit this: post in #patchwork-testers or email chee@inkandswitch.com`
  );
}

// todo this can be a function that takes a plugin system and returns a change
// handler

/**
 * Settings sources come keyed by name (`{ system, user }`). Each is an
 * Automerge module-settings doc (`automerge:…`, live) or an HTTP(S) URL to a
 * static JSON manifest of the same shape (fetched once), mixed freely. The
 * module URLs in either can be Automerge package docs or plain HTTP(S)
 * bundles.
 */
export class ModuleWatcher {
  repo: Repo;
  urls: Record<string, string>;
  handles: Record<string, DocHandle<ModuleSettingsDoc>> | undefined;
  staticManifests: Record<string, ModuleSettingsDoc> = {};
  doneLoading: Promise<void>;
  #watchedModules = new Map<string, WatchedModule>();
  // Bumped when a newer announce starts for a module, so a retry chain still
  // backing off from an older version gives up instead of rolling the
  // registry back to it.
  #announceGenerations = new Map<string, number>();
  #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #lastAnnounced = new Map<string, string>();
  // The url each module was last handed to `onLoad` from. A branches doc's
  // default branch is a different document from the settings entry, so this is
  // what an unload has to name for its plugins to be found.
  #loadedUrls = new Map<string, string>();
  #activeModules = new Set<string>();
  #disposed = false;
  #plan: LoadPlan | undefined;
  // The sources given to the constructor have been read.
  #sourcesRead = gate();

  /**
   * Told the url the module was imported from (pinned to heads, for an
   * Automerge package), the module itself, and the module's stable identity:
   * the settings-doc entry it was loaded for, which {@link onUnload} is told
   * when it goes away.
   */
  onLoad: (name: string, mod: any, moduleKey: string) => void;
  /**
   * Told a module's stable identity, and the url it was last loaded from,
   * when it goes away: either because it left the settings, or because a
   * reload came from a different document than the last load did (a branches
   * doc's default branch moved), whose plugins the new load won't replace.
   */
  onUnload?: (moduleKey: string, importUrl: string) => void;
  /** Told every module the settings list, whenever it (re)reads them. */
  onModules?: (modules: string[]) => void;
  /**
   * Turns an Automerge package doc, pinned to heads, into the `{ plugins }`
   * `onLoad` takes. By default it imports the entry point on this thread; the
   * browser bootloader runs it in a worker instead.
   */
  importAutomergePackage: (urlAtHeads: string) => Promise<any>;
  /**
   * How a package doc is looked up at its latest heads and watched for new
   * ones. Defaults to holding each one in `repo`; the browser passes
   * {@link trackPackagesViaServiceWorker}.
   */
  tracker: PackageTracker;

  constructor(
    repo: Repo,
    urls: Record<string, string>,
    callback: (name: string, mod: any, moduleKey: string) => void,
    onUnload?: (moduleKey: string, importUrl: string) => void,
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
    this.#sourcesRead.open();
    if (this.#disposed) return;
    await this.load();
  }

  /**
   * Load `batches` ahead of everything else, one after another: each opens
   * once every entry in the one before has loaded and provided the plugins
   * it was expected to. Modules in no batch wait for the last. If an entry
   * fails, comes back without a plugin it was expected to provide, or a batch
   * takes longer than {@link BATCH_TIME_LIMIT_MS}, everything still held back
   * is let go at once.
   *
   * Call it straight after constructing the watcher, before its first load.
   * Resolves true once every batch loaded as expected, and false if the plan
   * fell back (or there was nothing to plan).
   */
  prioritize(batches: LoadBatch[]): Promise<boolean> {
    const planned = batches
      .map((batch) => new Map(Object.entries(batch)))
      .filter((batch) => batch.size > 0);
    if (!planned.length || this.#plan || this.#disposed) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((settle) => {
      this.#plan = {
        batches: planned,
        opened: 0,
        gates: [...planned, null].map(() => gate()),
        provided: new Map(),
        failed: new Set(),
        settle,
      };
      this.#openNextBatch();
    });
  }

  #openNextBatch() {
    const plan = this.#plan;
    if (!plan) return;
    clearTimeout(plan.timer);
    plan.gates[plan.opened++].open();
    if (plan.opened > plan.batches.length) {
      this.#endPlan(true);
      return;
    }
    plan.timer = setTimeout(
      () =>
        this.#fallBack(
          `batch ${plan.opened} took more than ${BATCH_TIME_LIMIT_MS}ms`
        ),
      BATCH_TIME_LIMIT_MS
    );
    this.#checkBatch();
  }

  /** Opens the next batch if the open one has loaded as expected. */
  #checkBatch() {
    const plan = this.#plan;
    if (!plan) return;
    const batch = plan.batches[plan.opened - 1];
    for (const [entry, expected] of batch) {
      if (plan.failed.has(entry)) {
        this.#fallBack(`${entry} failed to load`);
        return;
      }
      const provided = plan.provided.get(entry);
      if (!provided) return;
      const missing = expected.find((ref) => !provided.has(refKey(ref)));
      if (missing) {
        this.#fallBack(
          `${entry} no longer provides ${missing.type} ${missing.id}`
        );
        return;
      }
    }
    this.#openNextBatch();
  }

  #fallBack(reason: string) {
    const plan = this.#plan;
    if (!plan) return;
    log(`letting every module load: ${reason}`);
    for (const { open } of plan.gates) open();
    this.#endPlan(false);
  }

  #endPlan(held: boolean) {
    const plan = this.#plan;
    if (!plan) return;
    clearTimeout(plan.timer);
    this.#plan = undefined;
    plan.settle(held);
  }

  /** Waits for `entry`'s batch to open, if a plan is holding it back. */
  #turnOf(entry: string): Promise<void> | undefined {
    const plan = this.#plan;
    if (!plan) return undefined;
    const batch = plan.batches.findIndex((batch) => batch.has(entry));
    const index = batch === -1 ? plan.batches.length : batch;
    if (index < plan.opened) return undefined;
    return plan.gates[index].promise;
  }

  #noteLoaded(entry: string, mod: any) {
    const plan = this.#plan;
    if (!plan) return;
    const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
    plan.provided.set(
      entry,
      new Set(
        plugins
          .filter((p) => typeof p?.type === "string" && typeof p?.id === "string")
          .map(refKey)
      )
    );
    this.#checkBatch();
  }

  #noteFailed(entry: string) {
    const plan = this.#plan;
    if (!plan) return;
    plan.failed.add(entry);
    this.#checkBatch();
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
          const turn = this.#turnOf(importName);
          if (turn) {
            await turn;
            // It may have left the settings while it waited.
            if (this.#disposed || !this.#activeModules.has(importName)) return;
          }
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

  private async processModuleEntry(importName: string) {
    if (isValidAutomergeUrl(importName)) {
      // Watch before looking up, so a change landing in between still reloads.
      // Keyed by the settings entry, a branches doc's included, so removing
      // it from settings unloads this module.
      const entry = this.watchPackage(importName, stripHeads(importName));
      if (!entry) return;
      let latest: AutomergeUrl | undefined;
      try {
        latest = await this.findLatestVersion(importName, entry);
      } catch (error) {
        this.retryLookup(importName, entry, error);
        this.#noteFailed(importName);
        return;
      }
      // A newer lookup took over, and announces what it finds.
      if (!latest) return;
      entry.failures = 0;
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
    // A plan may want this source's modules first, so it can't wait for the
    // others to load. Without one, the constructor's sources load first.
    await (this.#plan ? this.#sourcesRead.promise : this.doneLoading);
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
   * is its stable identity (the settings-doc entry); `importUrl` may be pinned
   * to heads. A newer announce for the same key supersedes this one.
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
      // A newer announce started meanwhile; its result wins.
      if (!current()) return;
      if (mod) {
        this.#lastAnnounced.set(moduleKey, versionKey);
        this.unloadIfDocumentChanged(moduleKey, importUrl);
        this.#loadedUrls.set(moduleKey, importUrl);
        this.onLoad(importUrl, mod, moduleKey);
        this.#noteLoaded(moduleKey, mod);
        return;
      }
      this.#noteFailed(moduleKey);
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
   * heads, on the trailing edge so a push's burst is one import. Heads, not
   * `lastSyncAt`: an offline `save` never stamps that. With `baseline`, the
   * current version is looked up now and only what comes after it reloads.
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
        // whatever this is. If it already failed, nothing is coming.
        if (first && entry.version === undefined && entry.failures === 0) {
          return;
        }
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
      failures: 0,
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
   * One lookup and import at a time per package: a doc still syncing in says
   * it changed with every batch, and a lookup or import can take as long as
   * the worker's resolve timeout, so one per change piles up on a busy worker.
   * Changes meanwhile collapse into one more.
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
      this.retryLookup(importName, entry, error);
      return;
    }
    if (!latest) return;
    entry.failures = 0;
    if (latest === entry.version) return;
    entry.version = latest;
    if (entry.baseline) {
      entry.baseline = false;
      return;
    }
    if (this.#lastAnnounced.get(importName) === latest) return;
    log(`change in ${importName}, reloading at ${latest}`);
    // Keyed by the stable importName so this reload supersedes any
    // still-retrying announce of an older version of the same module.
    await this.announce(
      isValidAutomergeUrl(importName)
        ? latest
        : pinServiceWorkerUrl(importName, latest),
      importName,
      latest
    );
  }

  /**
   * A failed lookup leaves the watch with nothing to compare against, and
   * nothing else brings it back until the package changes, so try again the
   * way a failed import does.
   */
  private retryLookup(
    importName: string,
    entry: WatchedModule,
    error: unknown
  ) {
    // The watch went while the lookup was out (the module left the settings,
    // or the watcher was disposed), so nothing is waiting on it.
    if (this.#watchedModules.get(importName) !== entry) return;
    console.warn(`couldn't look up the heads of ${importName}`, error);
    const delay = RETRY_DELAYS_MS[entry.failures++];
    if (delay === undefined) return;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = setTimeout(() => {
      entry.retry = undefined;
      void this.reloadIfMoved(importName, entry);
    }, delay);
  }

  /**
   * A reload from another document than the last load's (a branches doc's
   * default branch was pointed elsewhere) leaves the old document's plugins
   * registered, since registering only replaces what the same document made.
   */
  private unloadIfDocumentChanged(moduleKey: string, importUrl: string) {
    const previous = this.#loadedUrls.get(moduleKey);
    if (
      previous &&
      isValidAutomergeUrl(previous) &&
      isValidAutomergeUrl(importUrl) &&
      stripHeads(previous) !== stripHeads(importUrl)
    ) {
      this.onUnload?.(moduleKey, previous);
    }
  }

  private detachDocWatcher(importName: string) {
    const watched = this.#watchedModules.get(importName);
    if (!watched) return;
    if (watched.timer) clearTimeout(watched.timer);
    if (watched.retry) clearTimeout(watched.retry);
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
    this.#lastAnnounced.delete(entry);
    const loadedUrl = this.#loadedUrls.get(entry) ?? entry;
    this.#loadedUrls.delete(entry);
    this.onUnload?.(entry, loadedUrl);
  }

  dispose() {
    this.#disposed = true;
    this.#fallBack("the watcher was disposed");
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
    this.#activeModules.clear();
  }

  private async load() {
    if (!this.handles) throw new Error("No handles");
    const urls = new Set<string>();
    for (const { doc } of this.settingsDocs()) {
      for (const m of doc?.modules ?? []) urls.add(m);
    }
    this.onModules?.([...urls]);
    const previousActive = this.#activeModules;
    this.#activeModules = urls;
    for (const previous of previousActive) {
      if (!urls.has(previous)) this.unloadModule(previous);
    }
    await this.loadModules([...urls]);
  }
}
