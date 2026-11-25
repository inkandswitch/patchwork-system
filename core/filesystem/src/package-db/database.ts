import EventEmitter from "eventemitter3";
import {
  hasPluginManifest,
  importModule,
  importPluginFromPackage,
  resolvePackageExport,
} from "../packages.js";
import {
  deleteCurrent,
  openSaved,
  readCurrent,
  readVersions,
  writeCurrent,
} from "./saved.js";
import type {
  AddedBy,
  LivePlugin,
  PackageEntry,
  PluginView,
} from "./types.js";

type Events = {
  added: (entry: PackageEntry) => void;
  replaced: (entry: PackageEntry, previous: PackageEntry) => void;
  removed: (entry: PackageEntry) => void;
  loaded: (view: PluginView) => void;
};

/**
 * The packages a page has, at their newest version, and the plugins they
 * describe. Lookups are synchronous; loading a plugin's code is not.
 */
export class PackageDatabase {
  // Map order is add order, so the last entry is the newest.
  #entries = new Map<string, PackageEntry>();
  #loads = new Map<string, Promise<unknown>>();
  #modules = new Map<string, unknown>();
  #events = new EventEmitter<Events>();
  #importModule: (url: string) => Promise<any>;
  #saved?: IDBDatabase;
  #writes: Promise<void> = Promise.resolve(); // writes go in order
  ready: Promise<void> = Promise.resolve();

  constructor(options: { importModule?: (url: string) => Promise<any> } = {}) {
    this.#importModule = options.importModule ?? importModule;
  }

  /** An `addedBy` array replaces the adders; one adder joins them. */
  add(
    input: Omit<PackageEntry, "addedBy" | "addedAt"> & {
      addedBy: AddedBy | AddedBy[];
    },
  ): PackageEntry {
    const { addedBy, ...rest } = input;
    const adders = (list: AddedBy[]) =>
      Array.isArray(addedBy) ? [...addedBy] : mergeAddedBy(list, addedBy);
    const plugins = rest.plugins.map(rename);
    const previous = this.#entries.get(rest.key);
    const sameVersion = previous?.version === rest.version;
    // Only an add of exactly what's there is merged into it. An automerge url
    // with heads names exact content; an http url can change under itself.
    const same = previous && sameVersion &&
      previous.importUrl === rest.importUrl &&
      (rest.importUrl.startsWith("automerge:") ||
        JSON.stringify(previous.plugins) === JSON.stringify(plugins)) &&
      !plugins.some(isLive);
    if (same) {
      previous.addedBy = adders(previous.addedBy);
      this.#save(previous);
      return previous;
    }
    const entry: PackageEntry = {
      ...rest,
      plugins,
      addedBy: adders(previous && sameVersion ? [...previous.addedBy] : []),
      addedAt: Date.now(),
    };
    this.#entries.delete(entry.key);
    this.#entries.set(entry.key, entry);
    this.#save(entry);
    if (previous) {
      this.#forget(previous);
      this.#events.emit("replaced", entry, previous);
    } else {
      this.#events.emit("added", entry);
    }
    return entry;
  }

  remove(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#forget(entry);
    this.#write(() => deleteCurrent(this.#saved!, key));
    this.#events.emit("removed", entry);
    return true;
  }

  /**
   * Hydrate from the database called `name`, and save to it from now on.
   * With `hydrate: false` nothing saved is loaded, and `ready` doesn't wait.
   */
  open(
    name: string,
    { hydrate = true }: { hydrate?: boolean } = {},
  ): Promise<void> {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    const opened = this.#open(name, hydrate);
    if (hydrate) this.ready = opened;
    return opened;
  }

  /** Every saved version of a package, oldest first. */
  async versions(key: string): Promise<PackageEntry[]> {
    if (!this.#saved) return [];
    await this.#writes;
    return readVersions(this.#saved, key);
  }

  /** Tell other tabs a package changed. */
  announce(key: string) {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ key });
    channel.close();
  }

  onNews(cb: (key: string) => void): () => void {
    if (typeof BroadcastChannel === "undefined") return () => {};
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => cb(event.data.key);
    return () => channel.close();
  }

  get(key: string): PackageEntry | undefined {
    return this.#entries.get(key);
  }

  all(): PackageEntry[] {
    return [...this.#entries.values()];
  }

  plugins(type: string): PluginView[] {
    return this.all().flatMap((entry) =>
      entry.plugins
        .filter((plugin) => plugin.type === type)
        .map((plugin) => this.#view(entry, plugin))
    );
  }

  /**
   * The newest plugin with this id, preferring one that something other than
   * a `<patchwork-view package-url>` added.
   */
  plugin(type: string, id: string): PluginView | undefined {
    const entries = this.all();
    let fallback: PluginView | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const plugin = entries[i].plugins.find(
        (plugin) => plugin.type === type && plugin.id === id,
      );
      if (!plugin) continue;
      const view = this.#view(entries[i], plugin);
      if (entries[i].addedBy.some((a) => a.by !== "package-url")) return view;
      fallback ??= view;
    }
    return fallback;
  }

  load(view: PluginView): Promise<unknown> {
    const key = loadKey(view.importUrl, view.type, view.id);
    const existing = this.#loads.get(key);
    if (existing) return existing;
    const promise: Promise<unknown> = this.#import(view).then(
      (module) => {
        // Replaced or removed while loading.
        if (this.#loads.get(key) !== promise) return module;
        this.#modules.set(key, module);
        this.#events.emit("loaded", { ...view, module });
        return module;
      },
      (error) => {
        if (this.#loads.get(key) === promise) this.#loads.delete(key);
        throw error;
      },
    );
    this.#loads.set(key, promise);
    return promise;
  }

  isLoading(view: PluginView): boolean {
    const key = loadKey(view.importUrl, view.type, view.id);
    return this.#loads.has(key) && !this.#modules.has(key);
  }

  on(event: "added" | "removed", cb: (entry: PackageEntry) => void): () => void;
  on(
    event: "replaced",
    cb: (entry: PackageEntry, previous: PackageEntry) => void,
  ): () => void;
  on(event: "loaded", cb: (view: PluginView) => void): () => void;
  on(event: keyof Events, cb: (...args: any[]) => void): () => void {
    this.#events.on(event, cb);
    return () => {
      this.#events.off(event, cb);
    };
  }

  async #open(name: string, hydrate: boolean) {
    const db = await openSaved(name);
    const hydrated = (hydrate ? await readCurrent(db) : [])
      .filter((entry) => !this.#entries.has(entry.key))
      .sort((a, b) => a.addedAt - b.addedAt);
    // Saved entries are older than what was added meanwhile.
    const before = [...this.#entries.values()];
    this.#entries = new Map(
      [...hydrated, ...before].map((entry) => [entry.key, entry]),
    );
    this.#saved = db;
    for (const entry of before) this.#save(entry);
    for (const entry of hydrated) this.#events.emit("added", entry);
    await this.#writes;
  }

  // Only what a package list added comes back next visit.
  #save(entry: PackageEntry) {
    const listed = entry.addedBy.some((a) => a.by === "package-list");
    if (!listed || entry.plugins.some(isLive)) return;
    this.#write(() => writeCurrent(this.#saved!, entry));
  }

  #write(write: () => Promise<void>) {
    if (!this.#saved) return;
    this.#writes = this.#writes.then(write).catch((error) => {
      console.warn("couldn't save the package database", error);
    });
  }

  async #import(view: PluginView): Promise<unknown> {
    if ("module" in view) return view.module;
    const { load, import: url } = view as LivePlugin;
    if (typeof load === "function") return load();
    if (typeof url === "string") return this.#importModule(url);
    const { packageJson, base } = view.package;
    if (packageJson && hasPluginManifest(packageJson)) {
      if (view.export === undefined) return undefined;
      const entryPoint = resolvePackageExport(packageJson, view.export);
      const mod = await this.#importModule(new URL(entryPoint, base).href);
      return "default" in mod ? mod.default : mod;
    }
    // An index.js package: its entry point says what each plugin is.
    return importPluginFromPackage(
      view.importUrl,
      view.type,
      view.id,
      undefined,
      undefined,
      this.#importModule,
    );
  }

  #view(entry: PackageEntry, plugin: LivePlugin): PluginView {
    const view: PluginView = {
      ...plugin,
      importUrl: entry.importUrl,
      package: entry,
    };
    const key = loadKey(entry.importUrl, plugin.type, plugin.id);
    if (this.#modules.has(key)) view.module = this.#modules.get(key);
    return view;
  }

  // Drop what an entry's plugins loaded, so a live replacement loads afresh.
  #forget(entry: PackageEntry) {
    for (const plugin of entry.plugins) {
      const key = loadKey(entry.importUrl, plugin.type, plugin.id);
      this.#loads.delete(key);
      this.#modules.delete(key);
    }
  }
}

const CHANNEL = "patchwork:packages";

function loadKey(importUrl: string, type: string, id: string) {
  return `${importUrl} ${type} ${id}`;
}

function isLive(plugin: LivePlugin) {
  return plugin.load !== undefined || plugin.import !== undefined ||
    plugin.module !== undefined;
}

// One record per adder; for js, one per url, with the newest stack.
function mergeAddedBy(list: AddedBy[], addedBy: AddedBy): AddedBy[] {
  const same = (a: AddedBy) =>
    a.by === "js" && addedBy.by === "js"
      ? a.url === addedBy.url
      : JSON.stringify(a) === JSON.stringify(addedBy);
  const i = list.findIndex(same);
  if (i === -1) list.push(addedBy);
  else list[i] = addedBy;
  return list;
}

// Legacy names, and functions that can't be saved, which aren't supported.
function rename(plugin: LivePlugin): LivePlugin {
  const { supportedDataTypes, ...renamed } = plugin;
  if (supportedDataTypes !== undefined) {
    renamed.supportedDatatypes ??= supportedDataTypes;
  }
  if (renamed.type === "patchwork:dataType") renamed.type = "patchwork:datatype";
  for (const [name, value] of Object.entries(renamed)) {
    if (typeof value !== "function" || name === "load" || name === "module") {
      continue;
    }
    console.warn(
      `${renamed.type}:${renamed.id} has a function "${name}", which isn't supported; skipping it`,
    );
    delete renamed[name];
  }
  return renamed;
}

export const packages: PackageDatabase = new PackageDatabase();
