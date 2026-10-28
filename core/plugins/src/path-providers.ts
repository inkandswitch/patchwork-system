// A datatype package says what a document of its type contains by registering
// a `patchwork:path-provider` plugin. Tabs walk paths through them; the
// automerge worker never loads package code, so it walks built-ins only.
import {
  getType,
  providerFor,
  type ExtraProviders,
  type HasPatchworkMetadata,
  type PathProvider,
} from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "./registry/index.js";
import type { LoadablePlugin, PluginDescription } from "./registry/types.js";

export const PATH_PROVIDER = "patchwork:path-provider";

export type PathProviderDescription = PluginDescription & {
  type: typeof PATH_PROVIDER;
  /** The datatypes it walks. `"*"` isn't honored: built-ins aside, a provider says what it walks. */
  supportedDatatypes: string[];
};

export type PathProviderPlugin = LoadablePlugin<PathProviderDescription, PathProvider>;

const registry = () => getRegistry<PathProviderDescription>(PATH_PROVIDER);

const warned = new Set<string>();
const warnOnce = (key: string, ...message: unknown[]) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...message);
};

const datatypesOf = (plugin: PathProviderDescription): string[] => {
  const types = Array.isArray(plugin.supportedDatatypes) ? plugin.supportedDatatypes : [];
  if (types.includes("*")) {
    warnOnce(`${plugin.id} *`, `path provider ${plugin.id}: "*" in supportedDatatypes is ignored`);
  }
  return types.filter((type) => typeof type === "string" && type !== "*");
};

const isProvider = (module: unknown): module is PathProvider =>
  !!module &&
  typeof module === "object" &&
  ["matches", "lookup", "list"].every(
    (method) => typeof (module as Record<string, unknown>)[method] === "function"
  );

/**
 * The plugin provider for `doc`: the first, in registration order, that supports its type,
 * loads, is shaped like a provider, and `matches` it. What a tab passes walks as `providers`.
 */
export const packagePathProviders: ExtraProviders = async (doc) => {
  const type = getType((doc ?? {}) as HasPatchworkMetadata);
  if (!type) return undefined;
  for (const plugin of registry().filter((p) => datatypesOf(p).includes(type))) {
    let module: unknown;
    try {
      module = (await registry().load(plugin.id))?.module;
    } catch (error) {
      warnOnce(`${plugin.id} load`, `path provider ${plugin.id} didn't load`, error);
      continue;
    }
    if (!isProvider(module)) {
      warnOnce(`${plugin.id} shape`, `path provider ${plugin.id} lacks matches, lookup or list`);
      continue;
    }
    try {
      if (module.matches(doc)) return module;
    } catch {
      // a provider whose matches throws walks nothing
    }
  }
  return undefined;
};

/** Built-ins first, which a plugin can't override, then {@link packagePathProviders}. */
export async function pathProviderFor(doc: unknown): Promise<PathProvider | undefined> {
  return providerFor(doc) ?? (await packagePathProviders(doc));
}

/** Every type some path-provider plugin supports, without loading any. */
export function pathProviderTypes(): Set<string> {
  return new Set(registry().all().flatMap((plugin) => datatypesOf(plugin)));
}
