import { DatatypeDescription } from "../datatypes.js";
import { ToolDescription } from "../tools.js";
import type { PathProviderDescription } from "../path-providers.js";

export interface PluginRegistryEvents<D extends PluginDescription, I = any> {
  registered: (plugin: Plugin<D, I>) => void;
  loaded: (plugin: LoadedPlugin<D, I>) => void;
  removed: (id: string) => void;
  changed: () => void;
}

/**
 * Map of registry types and their corresponding plugin description types
 * can be extended with `declare module "@inkandswitch/patchwork-plugins" { ... }`
 * to add new registry types in userland while maintaining type safety.
 */
export type RegistryTypeMap = {
  "patchwork:tool": ToolDescription;
  "patchwork:datatype": DatatypeDescription;
  "patchwork:path-provider": PathProviderDescription;
};

/**
 * Base interface for all plugin descriptions
 */
export interface PluginDescription {
  id: string;
  type: string;
  name: string;
  icon?: string; // an icon name from the icon font
  importUrl?: string;
}

/**
 * Generic loadable plugin
 * D = Description type that extends PluginDescription
 * I = Implementation type that will be loaded
 */
export type LoadablePlugin<
  D extends PluginDescription = PluginDescription,
  I = any,
> = D &
  ({ load: () => Promise<I> } | { import: string });

/**
 * A fully loaded plugin combining description and implementation
 * D = Description type, I = Implementation type
 */
export type LoadedPlugin<
  D extends PluginDescription = PluginDescription,
  I = any,
> = D & {
  module: I;
};

// NOTE: I know i know... this is here so that Plugin<any, any> is PluginDescription and doesn't collapse to 'any'
type IsAny<T> = 0 extends 1 & T ? true : false;

export type Plugin<D extends PluginDescription = PluginDescription, I = any> =
  IsAny<D> extends true
    ? PluginDescription & { [key: string]: any }
    : LoadedPlugin<D, I> | D;
