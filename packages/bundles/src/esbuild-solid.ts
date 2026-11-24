import { readFile } from "node:fs/promises";
import type { Loader, Plugin } from "esbuild";
import { JSX_FILE } from "./solid.js";

export interface Compiled {
  code: string;
  /** A sourcemap, as an object or JSON. */
  map: object | string;
  /** What esbuild reads the compiled code as. */
  loader: Loader;
}

/**
 * An esbuild plugin that compiles each .jsx and .tsx file with `compile`,
 * which returns `undefined` to leave a file to esbuild.
 */
export function esbuildJSX(
  name: string,
  compile: (code: string, path: string) => Promise<Compiled | undefined>
): Plugin {
  return {
    name,
    setup(build) {
      build.onLoad({ filter: JSX_FILE }, async ({ path }) => {
        const compiled = await compile(await readFile(path, "utf8"), path);
        if (!compiled) return;
        const map =
          typeof compiled.map == "string"
            ? compiled.map
            : JSON.stringify(compiled.map);
        return {
          contents: `${compiled.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}`,
          loader: compiled.loader,
        };
      });
    },
  };
}
