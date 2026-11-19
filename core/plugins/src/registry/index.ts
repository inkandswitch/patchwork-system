import type { Tool } from "../tools.js";
import { PluginRegistry } from "./registry.js";
import { sourceOf } from "./source.js";
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
 */
export function getRegistry<T extends PluginDescription>(
  type: string
): PluginRegistry<T> {
  if (!registries[type]) {
    registries[type] = new PluginRegistry<T>();
  }

  return registries[type] as PluginRegistry<T>;
}

// todo remove this tomorrow
// ugly and transitional
function migrate(plugin: LoadablePlugin) {
  if (plugin.type == "patchwork:tool") {
    const tool = plugin as Tool;
    if ("supportedDataTypes" in tool) {
      console.warn(
        plugin.id,
        plugin.importUrl,
        "supportedDataTypes was renamed to supportedDatatypes (lowercase t in types). fix it to get rid of this warning"
      );
      tool.supportedDatatypes = tool.supportedDataTypes as string[];
    }
  } else if (plugin.type == "patchwork:dataType") {
    console.warn(
      plugin.id,
      plugin.importUrl,
      '"type": "patchwork:dataType" was renamed to patchwork:datatype (lowercase t in type). fix it to get rid of this warning'
    );
    plugin.type = "patchwork:datatype";
  }
}

/**
 * Remove every plugin registered from the same package as `importUrl`, except
 * those `keep` holds as "<type> <id>".
 */
function removeFromSource(importUrl: string, keep = new Set<string>()) {
  const source = sourceOf(importUrl);
  for (const [type, registry] of Object.entries(registries)) {
    for (const plugin of registry.all()) {
      if (sourceOf(plugin.importUrl) !== source) continue;
      if (keep.has(`${type} ${plugin.id}`)) continue;
      registry.remove(plugin.id);
    }
  }
}

/**
 * Register a package's plugins. Whatever an earlier version of the same
 * package registered and this one no longer provides is removed first. The
 * ids this one still provides are replaced in place instead, so a mounted
 * view reloads once rather than finding its tool gone and then back.
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
    // Migrating renames types, which `keep` has to be keyed by.
    migrate(plugin);
    return true;
  });
  removeFromSource(
    importUrl,
    new Set(typed.map((plugin) => `${plugin.type} ${plugin.id}`))
  );
  typed.forEach((plugin) => {
    getRegistry(plugin.type).register(plugin, importUrl);
  });
}

/**
 * Remove all plugins that were registered from a given package, at any
 * version of it. This is the counterpart to registerPlugins() and is used when
 * a module is unloaded.
 */
export function unregisterPlugins(importUrl: string) {
  removeFromSource(importUrl);
}

/** The url every registered plugin was imported from, across all registries, once each. */
export function pluginImportUrls(): string[] {
  const urls = new Set<string>();
  for (const registry of Object.values(registries)) {
    for (const plugin of registry.all()) {
      if (plugin.importUrl) urls.add(plugin.importUrl);
    }
  }
  return [...urls];
}

export function getAllRegistries(): Map<string, PluginRegistry<any>> {
  return new Map(Object.entries(registries));
}
