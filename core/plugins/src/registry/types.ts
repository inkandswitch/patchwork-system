import { DatatypeDescription } from "../datatypes.js";
import { ToolDescription } from "../tools.js";

export interface PluginRegistryEvents<D extends PluginDescription, I = any> {
  registered: (plugin: Plugin<D, I>) => void;
  loaded: (plugin: LoadedPlugin<D, I>) => void;
  removed: (id: string) => void;
  changed: () => void;
}

/**
 * Whether a package is pinned, by the url a plugin was registered from: a
 * pinned package's registration of an id is used over any other's that isn't
 * pinned, whichever was registered first (`PluginRegistry.pinSources`,
 * `pinPluginSources`). The url is the one the package was loaded from, an
 * automerge url (at heads) or an http one.
 */
export type PinnedSources = (importUrl: string | undefined) => boolean;

/**
 * Map of registry types and their corresponding plugin description types
 * can be extended with `declare module "@inkandswitch/patchwork-plugins" { ... }`
 * to add new registry types in userland while maintaining type safety.
 */
export type RegistryTypeMap = {
  "patchwork:tool": ToolDescription;
  "patchwork:datatype": DatatypeDescription;
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
