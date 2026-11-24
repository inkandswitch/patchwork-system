import type { Plugin } from "esbuild";
import preset from "babel-preset-solid";
import { esbuildJSX } from "./esbuild-solid.js";
import { compileSolid, type SolidOptions } from "./solid.js";

export type { SolidOptions } from "./solid.js";

/**
 * Compiles Solid 1 JSX with babel-preset-solid, for the Solid the host
 * provides. The compiled code imports `solid-js/web`, which comes from the
 * host's importmap. A file whose leading `@jsxImportSource` names something
 * other than Solid is left to esbuild.
 *
 * ```ts
 * import patchwork from "@inkandswitch/patchwork-bundles/esbuild";
 * import solid from "@inkandswitch/patchwork-bundles/esbuild/solid1";
 *
 * await esbuild.build({ plugins: [patchwork(), solid()] });
 * ```
 */
export default function solid(options?: SolidOptions): Plugin {
  return esbuildJSX("solid1", async (code, path) => {
    const compiled = await compileSolid(code, path, preset, options);
    return compiled && { ...compiled, loader: "js" };
  });
}
