import EventEmitter from "eventemitter3";
import {
  packages,
  sourceOf,
  type LivePlugin,
  type PackageEntry,
  type PluginView,
} from "@inkandswitch/patchwork-filesystem";
import type {
  LoadedPlugin,
  PluginDescription,
  Plugin,
  PluginRegistryEvents,
  LoadablePlugin,
} from "./types";
import debug from "debug";
import type { DatatypeImplementation } from "../datatypes.js";

const log = debug("patchwork:plugins");

function isAsyncFunction(fn: unknown) {
  return (
    typeof fn == "function" &&
    Symbol.toStringTag in fn &&
    fn[Symbol.toStringTag] == "AsyncFunction"
  );
}

// Each register and remove is a new version, so the database never merges it
// into the one before.
let versions = 0;

/**
 * The plugins of one type in the package database.
 *
 * @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`, or
 * the tools from `@inkandswitch/patchwork-elements` (`tool`, `tools`,
 * `toolsForType`, `defaultTool`, `onToolsChange`).
 */
export class PluginRegistry<D extends PluginDescription, I = any> {
  #events = new EventEmitter<PluginRegistryEvents<D, I>>();
  // A registry made without a type takes its first plugin's.
  #type: string | undefined;

  constructor(type?: string) {
    this.#type = type;
    packages.on("added", (entry) => this.#changed(entry));
    packages.on("replaced", (entry, previous) => this.#changed(entry, previous));
    packages.on("removed", (entry) => {
      const ids = this.#ids(entry);
      if (!ids.length) return;
      for (const id of ids) this.#events.emit("removed", id);
      this.#events.emit("changed");
    });
    packages.on("loaded", (view) => {
      if (view.type !== this.#type) return;
      this.#events.emit("loaded", view as LoadedPlugin<D, I>);
      this.#events.emit("changed");
    });
  }

  #changed(entry: PackageEntry, previous?: PackageEntry) {
    const ids = this.#ids(entry);
    const dropped = previous
      ? this.#ids(previous).filter((id) => !ids.includes(id))
      : [];
    if (!ids.length && !dropped.length) return;
    for (const view of packages.plugins(this.#type!)) {
      if (view.package === entry) {
        this.#events.emit("registered", view as unknown as Plugin<D, I>);
      }
    }
    for (const id of dropped) this.#events.emit("removed", id);
    this.#events.emit("changed");
  }

  #ids(entry: PackageEntry): string[] {
    return entry.plugins
      .filter((plugin) => plugin.type === this.#type)
      .map((plugin) => plugin.id);
  }

  // One per id, the one added last winning.
  #views(): Map<string, PluginView> {
    if (this.#type === undefined) return new Map();
    return new Map(packages.plugins(this.#type).map((view) => [view.id, view]));
  }

  register(plugin: LoadablePlugin<D, I>, importUrl: string) {
    this.#type ??= plugin.type;
    const key = sourceOf(importUrl)!;
    const entry = packages.get(key);
    const others = entry?.addedBy.every((added) => added.by === "js")
      ? entry.plugins.filter(
          (p) => !(p.type === plugin.type && p.id === plugin.id)
        )
      : [];
    packages.add({
      key,
      version: `${importUrl}#${++versions}`,
      importUrl,
      plugins: [...others, plugin as unknown as LivePlugin],
      addedBy: { by: "js", url: importUrl, stack: new Error().stack ?? "" },
    });
  }

  get(id: string): Plugin<D, I> | undefined {
    return this.#views().get(id) as Plugin<D, I> | undefined;
  }

  all(): Plugin<D, I>[] {
    return [...this.#views().values()] as unknown as Plugin<D, I>[];
  }

  filter(filter: (plugin: Plugin<D, I>) => boolean): Plugin<D, I>[] {
    return this.all().filter(filter);
  }

  /**
   * Load a plugin by id, waiting for registration if the plugin has not been
   * registered yet. Useful when a consumer depends on a plugin that will be
   * registered by a later-loaded module bundle (e.g. the `account` datatype
   * which ships with the `patchwork-frame` bundle).
   */
  async loadWhenReady(id: string): Promise<LoadedPlugin<D, I>> {
    for (;;) {
      const loaded = await this.load(id);
      if (loaded) return loaded;
      // `load` also gives up when the plugin was re-registered mid-load, and
      // that registration has already fired. The new one is loadable now.
      if (this.has(id)) continue;
      await this.#registered(id);
    }
  }

  /** Resolves on the next registration of `id`, and stops listening then. */
  #registered(id: string): Promise<void> {
    return new Promise((resolve) => {
      const off = this.on("registered", (plugin) => {
        if (plugin.id !== id) return;
        off();
        resolve();
      });
    });
  }

  async load(id: string): Promise<LoadedPlugin<D, I> | undefined> {
    const view = this.#views().get(id);
    if (!view) {
      log(`Plugin not registered: ${id}`);
      return undefined;
    }
    if ("module" in view) return view as LoadedPlugin<D, I>;

    let module: unknown;
    try {
      module = await packages.load(view);
    } catch (error) {
      console.error(`Failed to load plugin implementation: ${id}`, error);
      throw error;
    }

    // If the plugin was removed or re-registered while loading, discard
    if (this.#views().get(id)?.package !== view.package) {
      log(`Plugin ${id} was replaced or removed during load, discarding`);
      return undefined;
    }

    // TODO: remove this
    if (view.type == "patchwork:datatype") {
      const impl = module as DatatypeImplementation | undefined;
      if (isAsyncFunction(impl?.getTitle)) {
        console.warn(
          view.id,
          view.importUrl,
          "getTitle should not be an async function"
        );
      }
      if (isAsyncFunction(impl?.setTitle)) {
        console.warn(
          view.id,
          view.importUrl,
          "setTitle should not be an async function"
        );
      }
    }

    return { ...view, module } as unknown as LoadedPlugin<D, I>;
  }

  async loadAll(plugins: Plugin<D, I>[]): Promise<LoadedPlugin<D, I>[]> {
    const loadPromises = plugins.map((plugin) => this.load(plugin.id));

    const results = await Promise.allSettled(loadPromises);
    return results.flatMap((result) =>
      result.status === "fulfilled" && result.value !== undefined
        ? [result.value]
        : []
    );
  }

  /**
   * Remove a plugin by ID: a new version of its package without it, or no
   * package if it was the only plugin. Emits "removed" and "changed" if the
   * plugin existed. Returns true if the plugin was found and removed, false
   * if it wasn't registered.
   */
  remove(id: string): boolean {
    const entry = this.#views().get(id)?.package;
    if (!entry) return false;
    const plugins = entry.plugins.filter(
      (p) => !(p.type === this.#type && p.id === id)
    );
    if (!plugins.length) return packages.remove(entry.key);
    const url = entry.importUrl;
    packages.add({
      ...entry,
      version: `${url}#${++versions}`,
      plugins,
      addedBy: { by: "js", url, stack: new Error().stack ?? "" },
    });
    return true;
  }

  isLoading(id: string): boolean {
    const view = this.#views().get(id);
    return view ? packages.isLoading(view) : false;
  }

  has(id: string): boolean {
    return this.#views().has(id);
  }

  /** Subscribe to plugin events. Returns an unsubscribe function. */
  on(
    event: "registered",
    callback: (plugin: Plugin<D, I>) => void | Promise<void>
  ): () => void;
  on(
    event: "loaded",
    callback: (plugin: LoadedPlugin<D, I>) => void | Promise<void>
  ): () => void;
  on(
    event: "removed",
    callback: (id: string) => void | Promise<void>
  ): () => void;
  on(event: "changed", callback: () => void | Promise<void>): () => void;
  on(
    event: keyof PluginRegistryEvents<D, I>,
    callback: (...args: any[]) => void | Promise<void>
  ): () => void {
    if (!callback || typeof callback !== "function") {
      throw new Error(`Invalid callback provided for event: ${event}`);
    }
    this.#events.on(event, callback);
    return () => {
      this.#events.off(event, callback);
    };
  }
}
