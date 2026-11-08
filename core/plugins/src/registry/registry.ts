import EventEmitter from "eventemitter3";
import type {
  LoadedPlugin,
  PluginDescription,
  Plugin,
  PluginRegistryEvents,
  LoadablePlugin,
} from "./types";
import debug from "debug";
import {
  isLoadablePlugin,
  isLoadedPlugin,
  isPluginDescription,
} from "./guards.js";
import type { DatatypeImplementation } from "../datatypes.js";

const log = debug("patchwork:plugins");

function isAsyncFunction(fn: unknown) {
  return (
    typeof fn == "function" &&
    Symbol.toStringTag in fn &&
    fn[Symbol.toStringTag] == "AsyncFunction"
  );
}

export class PluginRegistry<D extends PluginDescription, I = any> {
  #plugins = new Map<string, Plugin<D, I>>();
  #loadPromises = new Map<string, Promise<LoadedPlugin<D, I> | undefined>>();
  #events = new EventEmitter<PluginRegistryEvents<D, I>>();
  #loading = new Set<string>();

  register(plugin: LoadablePlugin<D, I>, importUrl: string) {
    if (importUrl && !plugin.importUrl) {
      plugin.importUrl = importUrl;
    }

    const existing = this.#plugins.get(plugin.id);

    if (existing) {
      if (existing.importUrl == importUrl) {
        log(`updating ${plugin.id} provided by "${existing.importUrl}"`);
      } else {
        console.warn(
          `overriding "${plugin.id}" provided by "${existing.importUrl}" with new plugin provided by "${importUrl}"`
        );
      }
    }

    this.#plugins.set(plugin.id, plugin);

    this.#loadPromises.delete(plugin.id);
    this.#loading.delete(plugin.id);

    this.#events.emit("registered", plugin);
    this.#events.emit("changed");
  }

  get(id: string): Plugin<D, I> | undefined {
    return this.#plugins.get(id);
  }

  all(): Plugin<D, I>[] {
    const entries = Array.from(this.#plugins.values());
    return entries as Plugin<D, I>[];
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
    log(`load called for: ${id}`, {});

    const description = this.#plugins.get(id);
    if (!description) {
      log(`Plugin not registered: ${id}`);
      return undefined;
    }

    if (isLoadedPlugin<D, I>(description)) {
      log(`Returning already loaded plugin: ${id}`);
      return description;
    }

    const existingPromise = this.#loadPromises.get(id);
    if (existingPromise) {
      log(`Returning in-flight load for: ${id}`);
      return existingPromise;
    }

    if (!isLoadablePlugin(description)) {
      throw new Error(`Plugin ${id} is not loadable`);
    }

    log(`Loading plugin implementation: ${id}`);
    this.#loading.add(id);

    const loadPromise: Promise<LoadedPlugin<D, I> | undefined> = (
      "load" in description
        ? description.load()
        : import(description.import)
    )
      .then((implementation) => {
        const clearIfOurs = () => {
          if (this.#loadPromises.get(id) === loadPromise) {
            this.#loadPromises.delete(id);
            this.#loading.delete(id);
          }
        };

        // If the plugin was removed or re-registered while loading, discard
        if (this.#plugins.get(id) !== description) {
          log(`Plugin ${id} was replaced or removed during load, discarding`);
          clearIfOurs();
          return undefined;
        }

        log(`Successfully loaded implementation for: ${id}`, implementation);
        // TODO: remove this
        const desc = description as LoadablePlugin<D, I>;
        if (desc.type == "patchwork:datatype") {
          const impl = implementation as DatatypeImplementation;
          if (isAsyncFunction(impl.getTitle)) {
            console.warn(
              desc.id,
              desc.importUrl,
              "getTitle should not be an async function"
            );
          }
          if (isAsyncFunction(impl.setTitle)) {
            console.warn(
              desc.id,
              desc.importUrl,
              "setTitle should not be an async function"
            );
          }
        }

        const {
          load: _load,
          import: _import,
          ...descriptionWithoutLoad
        } = desc as Record<string, any>;
        if (!isPluginDescription<D>(descriptionWithoutLoad)) {
          throw new Error("Invalid plugin description");
        }
        const plugin = {
          ...descriptionWithoutLoad,
          module: implementation,
        };

        this.#plugins.set(id, plugin);
        clearIfOurs();

        this.#events.emit("loaded", plugin);
        this.#events.emit("changed");

        return plugin;
      })
      .catch((error) => {
        console.error(`Failed to load plugin implementation: ${id}`, error);
        if (this.#loadPromises.get(id) === loadPromise) {
          this.#loadPromises.delete(id);
          this.#loading.delete(id);
        }
        throw error;
      });

    this.#loadPromises.set(id, loadPromise);
    return loadPromise;
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
   * Remove a plugin by ID. Emits "removed" and "changed" if the plugin existed.
   * Returns true if the plugin was found and removed, false if it wasn't registered.
   */
  remove(id: string): boolean {
    if (!this.#plugins.has(id)) {
      return false;
    }

    this.#plugins.delete(id);
    this.#loadPromises.delete(id);
    this.#loading.delete(id);

    this.#events.emit("removed", id);
    this.#events.emit("changed");

    return true;
  }

  isLoading(id: string): boolean {
    return this.#loading.has(id);
  }

  has(id: string): boolean {
    return this.#plugins.has(id);
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
