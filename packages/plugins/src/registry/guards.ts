import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
  Plugin,
} from "./types";

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export function isPluginDescription<D extends PluginDescription>(
  value: unknown
): value is D {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    "type" in value &&
    "name" in value
  );
}

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export function isLoadablePlugin<
  D extends PluginDescription = PluginDescription,
  I = any,
>(value: unknown): value is LoadablePlugin<D, I> {
  return (
    isPluginDescription<D>(value) &&
    (("load" in value && typeof value.load === "function") ||
      ("import" in value && typeof value.import === "string"))
  );
}

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export function isLoadedPlugin<
  D extends PluginDescription = PluginDescription,
  I = any,
>(value: unknown): value is LoadedPlugin<D, I> {
  return isPluginDescription<D>(value) && "module" in value;
}

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export function isPlugin<
  T extends PluginDescription = PluginDescription,
  I = any,
>(value: unknown): value is Plugin<T, I> {
  return isPluginDescription<T>(value);
}
