import EventEmitter from "eventemitter3";
import type {
  LoadedPlugin,
  PluginDescription,
  Plugin,
  PinnedSources,
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
import { sourceOf } from "./source.js";

const log = debug("patchwork:plugins");

function isAsyncFunction(fn: unknown) {
  return (
    typeof fn == "function" &&
    Symbol.toStringTag in fn &&
    fn[Symbol.toStringTag] == "AsyncFunction"
  );
}

const nothingPinned: PinnedSources = () => false;

/**
 * Every package's registration of each id is kept, in order: first the one
 * in use, then the ones it shadows, in the order they'd take over. A package
 * registering an id for the first time goes first, unless it's pinned and
 * what's there is (`pinSources`): pinned packages stay ahead of the rest. A
 * package registering again (its next version) keeps its place. So a package
 * overriding another's id shadows it rather than replacing it, and when the
 * overriding package goes, or drops the id, the other's is in use again. A
 * shadowed package updating changes nothing anyone sees.
 *
 * `get` and `all` are the plugins in use; `shadows` is what one shadows.
 */
export class PluginRegistry<D extends PluginDescription, I = any> {
  // id → every package's registration of it, the one in use first. Never
  // empty: an id nothing registers any more isn't here
  #registrations = new Map<string, Plugin<D, I>[]>();
  #pinned: PinnedSources = nothingPinned;
  #loadPromises = new Map<string, Promise<LoadedPlugin<D, I> | undefined>>();
  #events = new EventEmitter<PluginRegistryEvents<D, I>>();
  #loading = new Set<string>();

  register(plugin: LoadablePlugin<D, I>, importUrl: string) {
    if (importUrl && !plugin.importUrl) {
      plugin.importUrl = importUrl;
    }

    const existing = this.get(plugin.id);
    const registered = this.#registrations.get(plugin.id) ?? [];
    const source = sourceOf(plugin.importUrl);
    const at = registered.findIndex((p) => sourceOf(p.importUrl) == source);
    if (at >= 0) registered[at] = plugin;
    else registered.unshift(plugin);
    this.#registrations.set(plugin.id, this.#ordered(registered));

    this.#settle(plugin.id, existing);
    if (!existing) return;
    if (sourceOf(existing.importUrl) == source) {
      log(`updating ${plugin.id} provided by "${existing.importUrl}"`);
    } else if (this.get(plugin.id) === plugin) {
      console.warn(
        `overriding "${plugin.id}" provided by "${existing.importUrl}" with new plugin provided by "${importUrl}"`
      );
    } else {
      log(
        `"${plugin.id}" provided by "${importUrl}" is shadowed by "${this.get(plugin.id)?.importUrl}"`
      );
    }
  }

  /**
   * Which packages stay above the rest, by the url a plugin was registered
   * from: a pinned package's registration of an id is used over any other
   * that isn't pinned, whenever either was registered. Setting it moves each
   * id's pinned registrations ahead of the rest, in the order they were in.
   * Unpinning leaves the order as it is: what was pinned is in use till
   * something registers over it.
   */
  pinSources(pinned: PinnedSources | undefined) {
    this.#pinned = pinned ?? nothingPinned;
    for (const [id, registered] of [...this.#registrations]) {
      const was = registered[0];
      this.#registrations.set(id, this.#ordered(registered));
      this.#settle(id, was);
    }
  }

  // `registered` with its pinned registrations first, otherwise as it was
  #ordered(registered: Plugin<D, I>[]): Plugin<D, I>[] {
    const pinned = registered.filter((p) => this.#pinned(p.importUrl));
    if (!pinned.length) return registered;
    return [...pinned, ...registered.filter((p) => !pinned.includes(p))];
  }

  // Say so if the plugin in use for `id` isn't `was` any more
  #settle(id: string, was: Plugin<D, I> | undefined) {
    const now = this.get(id);
    if (now === was) return;
    this.#loadPromises.delete(id);
    this.#loading.delete(id);
    if (now) {
      this.#events.emit("registered", now);
    } else {
      this.#registrations.delete(id);
      this.#events.emit("removed", id);
    }
    this.#events.emit("changed");
  }

  /** The plugin in use for `id`. */
  get(id: string): Plugin<D, I> | undefined {
    return this.#registrations.get(id)?.[0];
  }

  /** Every plugin in use, one per id. */
  all(): Plugin<D, I>[] {
    return Array.from(
      this.#registrations.values(),
      (registered) => registered[0]
    );
  }

  /**
   * The registrations of `id` that the plugin in use shadows: other packages'
   * plugins with the id, in the order they'd take over if it went. Empty if
   * nothing's shadowed (or `id` isn't registered).
   */
  shadows(id: string): Plugin<D, I>[] {
    return this.#registrations.get(id)?.slice(1) ?? [];
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

    const description = this.get(id);
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
        if (this.get(id) !== description) {
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

        // in its place, so it's still loaded should it be shadowed, and in
        // use again
        const registered = this.#registrations.get(id)!;
        registered[registered.indexOf(description)] = plugin;
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
   * Remove the plugin in use for `id`, so the first one it shadowed is in
   * use now, if there is one. Emits "registered" and
   * "changed" if there is, "removed" and "changed" if there isn't. Returns
   * true if `id` was registered, false if it wasn't.
   */
  remove(id: string): boolean {
    const registered = this.#registrations.get(id);
    if (!registered) return false;
    const was = registered.shift();
    this.#settle(id, was);
    return true;
  }

  /**
   * Remove what the package `source` (a `sourceOf` url) registered, in use
   * or shadowed, except the ids `keep` says to. Where its plugin was in use,
   * the one under it is now, if there is one.
   */
  removeSource(
    source: string | undefined,
    keep: (id: string) => boolean = () => false
  ) {
    for (const [id, registered] of [...this.#registrations]) {
      if (keep(id)) continue;
      const left = registered.filter((p) => sourceOf(p.importUrl) != source);
      if (left.length == registered.length) continue;
      this.#registrations.set(id, left);
      this.#settle(id, registered[0]);
    }
  }

  isLoading(id: string): boolean {
    return this.#loading.has(id);
  }

  has(id: string): boolean {
    return this.#registrations.has(id);
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
