import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export { default } from "./externals-list.js";

/**
 * pretend the import came from inside this package, so node_modules resolution
 * walks up from *our* directory and finds our copy of each external. that's why
 * a consuming site never has to install them or agree with us about versions.
 */
const self = fileURLToPath(import.meta.url);

/**
 * Resolve one of this package's own dependencies from its node_modules
 * rather than the site's, so a vite plugin bundling it never needs the site
 * to install it or agree on a version. Exported so `@inkandswitch/patchwork`'s
 * vite plugin (which lives in a different package) can reuse this for the
 * externals bootloader actually owns, while resolving itself separately.
 *
 * This goes through rollup's resolver rather than import.meta.resolve or
 * require.resolve because those apply node's conditions: subduction (and
 * others) would hand us `dist/esm/node.js`, which imports node:path and blows
 * up at bundle time. rollup applies the browser conditions vite configured.
 */
export async function resolveExternal(
  this: import("rollup").PluginContext,
  name: string
): Promise<string> {
  const resolved = await this.resolve(name, self, { skipSelf: true });
  if (!resolved) {
    throw new Error(
      `@inkandswitch/patchwork-bootloader: couldn't resolve the external ` +
        `"${name}". it should be one of the bootloader's own dependencies.`
    );
  }
  return resolved.id;
}

/**
 * automerge/keyhive/subduction's wasm binaries, by the file name the service
 * worker fetches them under. Resolved from this package's node_modules for the
 * same reason as {@link resolveExternal}.
 */
export function wasmAssets(): { fileName: string; path: string }[] {
  return [
    {
      fileName: "automerge.wasm",
      path: require.resolve("@automerge/automerge/automerge.wasm"),
    },
    {
      fileName: "keyhive_wasm.wasm",
      path: require.resolve("@keyhive/keyhive/keyhive_wasm.wasm"),
    },
    {
      fileName: "subduction.wasm",
      path: require.resolve("@automerge/automerge-subduction/wasm"),
    },
  ];
}

/** Emits automerge/keyhive/subduction's wasm binaries as build assets, so the service worker can fetch them. */
export function emitWasmAssets(this: import("rollup").PluginContext): void {
  for (const { fileName, path } of wasmAssets()) {
    this.emitFile({
      type: "asset",
      fileName,
      source: readFileSync(path),
    });
  }
}
