import {
  type LivePlugin,
  packages,
  sourceOf,
} from "@inkandswitch/patchwork-filesystem";
import { PluginRegistry } from "./registry.js";
import { LoadablePlugin, PluginDescription } from "./types.js";

export { PluginRegistry };
export type {
  LoadablePlugin,
  LoadedPlugin,
  Plugin,
  PluginDescription,
  PluginRegistryEvents,
} from "./types.js";

const registries: Record<string, PluginRegistry<any>> = {};

/**
 * Get a registry for a specific plugin type, creating it if it doesn't exist
 * This implicitly registers the plugin type if it hasn't been registered yet
 *
 * @deprecated Use `packages.plugins(type)` from
 * `@inkandswitch/patchwork-filesystem`, or the tools from
 * `@inkandswitch/patchwork-elements`.
 */
export function getRegistry<T extends PluginDescription>(
  type: string
): PluginRegistry<T> {
  if (!registries[type]) {
    registries[type] = new PluginRegistry<T>(type);
  }

  return registries[type] as PluginRegistry<T>;
}

/**
 * Add a package's plugins to the package database, replacing what an earlier
 * version of it added. Left alone if a package list or a suggestion already
 * added that package at that url.
 *
 * @deprecated Use `packages.add` from `@inkandswitch/patchwork-filesystem`.
 */
export function registerPlugins<D extends PluginDescription, I>(
  plugins: LoadablePlugin<D, I>[],
  importUrl: string
) {
  const typed = plugins.filter((plugin) => {
    if (!plugin.type) {
      console.warn("Plugin has no type", plugin);
      return false;
    }
    return true;
  });
  const key = sourceOf(importUrl)!;
  const entry = packages.get(key);
  const added =
    entry?.importUrl === importUrl &&
    entry.addedBy.some((a) => a.by === "package-list" || a.by === "suggested");
  if (added) return;
  // Whoever added the package before still has it, as with `register`.
  const others = (entry?.addedBy ?? []).filter(
    (a) => !(a.by === "js" && a.url === importUrl)
  );
  packages.add({
    key,
    version: importUrl,
    importUrl,
    plugins: typed as unknown as LivePlugin[],
    addedBy: [
      ...others,
      { by: "js", url: importUrl, stack: new Error().stack ?? "" },
    ],
  });
}

/**
 * Remove the package `importUrl` is a version of.
 *
 * @deprecated Use `packages.remove(sourceOf(importUrl))` from
 * `@inkandswitch/patchwork-filesystem`.
 */
export function unregisterPlugins(importUrl: string) {
  packages.remove(sourceOf(importUrl)!);
}

/**
 * A registry for every plugin type in the package database.
 *
 * @deprecated Use `packages.all()` from `@inkandswitch/patchwork-filesystem`.
 */
export function getAllRegistries(): Map<string, PluginRegistry<any>> {
  for (const entry of packages.all()) {
    for (const plugin of entry.plugins) getRegistry(plugin.type);
  }
  return new Map(Object.entries(registries));
}
