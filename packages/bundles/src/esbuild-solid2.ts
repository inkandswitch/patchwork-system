import { basename } from "node:path";
import { transformAsync, type TransformOptions } from "@solidjs/compiler";
import type { Plugin } from "esbuild";
import { esbuildJSX } from "./esbuild-solid.js";
import { isSolid } from "./solid.js";

export type SolidOptions = Omit<TransformOptions, "filename" | "sourceMap">;

/**
 * Compiles Solid 2 JSX with @solidjs/compiler, the compiler Solid 2's own
 * vite plugin uses. The compiled code imports `@solidjs/web`. It leaves the
 * TypeScript in, for esbuild to strip with the package's tsconfig. A file
 * whose leading `@jsxImportSource` names something other than Solid is left
 * to esbuild.
 *
 * The host provides Solid 1 as `solid-js`, so a Solid 2 package bundles its
 * own: install `solid-js@2` and `@solidjs/web`, and tell the main plugin not to
 * leave `solid-js` to the host. The build fails if `solid-js` is still
 * external, since the package would get the host's Solid 1 at runtime.
 *
 * ```ts
 * import patchwork from "@inkandswitch/patchwork-bundles/esbuild";
 * import solid from "@inkandswitch/patchwork-bundles/esbuild/solid2";
 *
 * await esbuild.build({
 *   plugins: [patchwork({ bundle: ["solid-js"] }), solid()],
 * });
 * ```
 *
 * Anything else built on Solid 1 that the package bundles (solid-automerge,
 * say) will run against its Solid 2 and may not work.
 */
export default function solid(options: SolidOptions = {}): Plugin {
  const compile = esbuildJSX("solid2", async (code, path) => {
    if (!isSolid(code)) return;
    const result = await transformAsync(code, {
      generate: "dom",
      ...options,
      // the map is inlined into the file it describes, so it names that
      // file relative to itself
      filename: basename(path),
      sourceMap: true,
    });
    return {
      code: result.code,
      map: result.map ?? "",
      loader: path.endsWith(".tsx") ? "ts" : "js",
    };
  });
  return {
    name: "solid2",
    setup(build) {
      build.onStart(() => {
        const external = build.initialOptions.external ?? [];
        if (!external.some((id) => id == "solid-js" || id == "solid-js/web")) {
          return;
        }
        return {
          errors: [
            {
              text:
                "solid-js is external, so this package gets the host's " +
                "Solid 1 at runtime. Bundle Solid 2 instead: " +
                'patchwork({ bundle: ["solid-js"] }).',
            },
          ],
        };
      });
      return compile.setup(build);
    },
  };
}
