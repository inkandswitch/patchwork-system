import {
  type AutomergeUrl,
  type DocHandle,
  isValidAutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  importPackageFromFolderDocUrl,
  importPackageFromHttpUrl,
  injectImportMapForPackage,
} from "./packages.js";
import { getType, type HasPatchworkMetadata } from "./metadata.js";
import { BranchesDoc, FolderDoc } from "./types.js";
import debug from "debug";

const log = debug("patchwork:modules");

export type ModuleSettingsDoc = {
  modules: AutomergeUrl[];
} & HasPatchworkMetadata & {
    "@patchwork": { type: "patchwork:module-settings" };
  };

// A single pushwork sync commits a burst of changes to a folder doc — the
// file-list write, an optional pin refresh, and a trailing `lastSyncAt` stamp —
// and the file docs it references sync as independent documents. Coalesce that
// burst into one reload by waiting for the folder doc's heads to stop moving
// for this long before re-importing, so we pin to the settled, consistent
// snapshot instead of an intermediate one.
const RELOAD_DEBOUNCE_MS = 250;

// A package can fail to import just because the automerge worker serving its
// files is still coming up. Nothing else brings it back — setDocWatcher only
// fires when the folder doc's own heads move — so back off and try again.
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
  handle?: DocHandle<FolderDoc>;
  listener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_BRANCH = "default";

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
 * module URLs *within* either kind can themselves point at Automerge folder
 * docs or plain HTTP(S) bundles.
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
  #lastAnnounced = new Map<string, string>();
  #activeModules = new Set<string>();
  #disposed = false;

  onLoad: (name: string, mod: any) => void;
  onUnload?: (name: string) => void;
  /**
   * How an Automerge folder-doc module (pinned to heads) is turned into the
   * `{ plugins }` shape `onLoad` consumes. Defaults to importing the package
   * entry point directly on this thread. The browser bootloader overrides this
   * to run the entry point in a worker for descriptor discovery and rebuild the
   * `{ plugins }` shape with main-thread `load()` functions.
   */
  importAutomergePackage: (urlAtHeads: string) => Promise<any>;

  constructor(
    repo: Repo,
    urls: Record<string, string>,
    callback: (name: string, mod: any) => void,
    onUnload?: (name: string) => void,
    importAutomergePackage: (urlAtHeads: string) => Promise<any> = (url) =>
      importPackageFromFolderDocUrl(url as AutomergeUrl)
  ) {
    this.repo = repo;
    this.urls = { ...urls };
    this.onLoad = callback;
    this.onUnload = onUnload;
    this.importAutomergePackage = importAutomergePackage;
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

  private async processModuleEntry(importName: string) {
    if (isValidAutomergeUrl(importName)) {
      const handle =
        await this.repo.find<Partial<HasPatchworkMetadata>>(importName);
      if (getType(handle.doc()) === "branches") {
        warnBranchesUnsupported(importName);
        const branchesDoc = (handle as unknown as DocHandle<BranchesDoc>).doc();
        const folderUrl = branchesDoc?.branches?.[DEFAULT_BRANCH];
        if (!folderUrl) {
          console.warn(
            `branch "${DEFAULT_BRANCH}" not found in branches doc ${importName}`
          );
          return;
        }
        // Keyed by the branches doc URL — that's the settings entry, so
        // removing it from settings unloads this module.
        await this.watchAndAnnounce(
          importName,
          await this.repo.find<FolderDoc>(folderUrl)
        );
        return;
      }
      await this.watchAndAnnounce(
        importName,
        handle as unknown as DocHandle<FolderDoc>
      );
      return;
    }
    this.setDocWatcher(importName);
    if (this.#lastAnnounced.has(importName)) return;
    await this.announce(importName);
  }

  // Pin heads once so the watcher's change baseline and the announced import
  // come from the same snapshot — a change landing between two separate finds
  // would otherwise be lost until the next change.
  private async watchAndAnnounce(
    importName: AutomergeUrl,
    handle: DocHandle<FolderDoc>
  ) {
    const heads = handle.heads();
    const headsKey = heads.join(",");
    this.setDocWatcher(importName, handle, headsKey);
    if (this.#lastAnnounced.get(importName) === headsKey) return;
    await this.announce(handle.view(heads).url, importName, headsKey);
  }

  private async importPackageSafe(importName: string): Promise<any> {
    try {
      if (isValidAutomergeUrl(importName)) {
        // Pin to heads so descriptor discovery and any later main-thread load
        // resolve against the exact same version of the folder doc.
        const handle = await this.repo.find(importName as AutomergeUrl);
        const urlAtHeads = handle.view(handle.heads()).url;
        try {
          await injectImportMapForPackage(urlAtHeads);
        } catch (error) {
          console.warn(`couldn't inject importmap for ${urlAtHeads}`, error);
        }
        return await this.importAutomergePackage(urlAtHeads);
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
  private setDocWatcher(
    importName: string,
    handle?: DocHandle<FolderDoc>,
    headsKey?: string
  ) {
    if (this.#disposed) return;
    if (this.#watchedModules.has(importName)) return;
    const entry: WatchedModule = {};
    this.#watchedModules.set(importName, entry);

    if (handle) {
      this.attachDocWatcher(
        importName,
        entry,
        handle,
        headsKey ?? handle.heads().join(",")
      );
      return;
    }

    // Service-worker module URLs look like `origin/automerge%3A<id>/…` (the
    // encoded automerge URL as the first path segment).
    const encodedId = importName.match(/\/automerge%3A([^/]+)\//i)?.[1];
    const docUrl = encodedId && `automerge:${decodeURIComponent(encodedId)}`;
    if (!docUrl || !isValidAutomergeUrl(docUrl)) return;

    this.repo
      .find<FolderDoc>(docUrl)
      .then((found) => {
        if (this.#watchedModules.get(importName) !== entry) return;
        this.attachDocWatcher(
          importName,
          entry,
          found,
          found.heads().join(",")
        );
      })
      .catch((error) => {
        console.warn(
          `could not watch ${docUrl} for ${importName}; will retry on next load`,
          error
        );
        if (this.#watchedModules.get(importName) === entry) {
          this.#watchedModules.delete(importName);
        }
      });
  }

  private attachDocWatcher(
    importName: string,
    entry: WatchedModule,
    handle: DocHandle<FolderDoc>,
    initialHeadsKey: string
  ) {
    // Reload when the folder doc's heads actually change, debounced to the
    // trailing edge so a push's burst of changes collapses into one import at
    // the settled heads. This reacts to real content changes (including
    // offline `save`, which never stamps lastSyncAt) rather than a magic
    // timestamp field.
    let importedHeads = initialHeadsKey;
    const listener = () => {
      if (handle.heads().join(",") === importedHeads) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        const heads = handle.heads();
        const key = heads.join(",");
        if (key === importedHeads) return;
        importedHeads = key;
        const versionedImport = handle.view(heads).url;
        log(`change in ${importName}, reloading at ${versionedImport}`);
        // Keyed by the stable importName so this reload supersedes any
        // still-retrying announce of an older version of the same module.
        this.announce(versionedImport, importName, key);
      }, RELOAD_DEBOUNCE_MS);
    };
    entry.handle = handle;
    entry.listener = listener;
    handle.on("change", listener);
  }

  private detachDocWatcher(importName: string) {
    const watched = this.#watchedModules.get(importName);
    if (!watched) return;
    if (watched.timer) clearTimeout(watched.timer);
    if (watched.handle && watched.listener) {
      watched.handle.off("change", watched.listener);
    }
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
    this.onUnload?.(entry);
  }

  dispose() {
    this.#disposed = true;
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
    const previousActive = this.#activeModules;
    this.#activeModules = urls;
    for (const previous of previousActive) {
      if (!urls.has(previous)) this.unloadModule(previous);
    }
    await this.loadModules([...urls]);
  }
}
