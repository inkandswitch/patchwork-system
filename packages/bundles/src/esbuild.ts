import { unplugin } from "./index.js";

export type { Options } from "./index.js";

/**
 * The esbuild plugin:
 *
 * ```ts
 * import * as esbuild from "esbuild";
 * import patchwork from "@inkandswitch/patchwork-bundles/esbuild";
 *
 * await esbuild.build({ plugins: [patchwork()] });
 * ```
 */
export default unplugin.esbuild;
