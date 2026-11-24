import { basename } from "node:path";
import { transformAsync } from "@babel/core";
import { transform as esbuildTransform } from "esbuild";
import { jsxImportSource } from "./jsx-pragma.js";

/** Options for babel-preset-solid, passed through as they are. */
export interface SolidOptions {
  generate?: "dom" | "ssr" | "universal";
  hydratable?: boolean;
  [option: string]: unknown;
}

export const JSX_FILE = /\.[jt]sx$/;

/** The import sources that mean a file is Solid. */
const SOLID_SOURCES = ["solid-js", "@solidjs/web"];

/**
 * Whether a file is Solid's to compile: it names no `@jsxImportSource`, or
 * names Solid's.
 */
export function isSolid(code: string): boolean {
  const importSource = jsxImportSource(code);
  return !importSource || SOLID_SOURCES.includes(importSource);
}

/**
 * Compiles one .jsx or .tsx file with babel-preset-solid (Solid 1). Returns
 * `undefined` for a file whose `@jsxImportSource` names something other than
 * Solid, so the bundler compiles that one its own way (react, say).
 *
 * TypeScript is stripped by esbuild first, keeping the JSX, since the preset
 * can't read it. That doesn't read tsconfig.json, so under
 * `verbatimModuleSyntax` an import of nothing but types is dropped rather
 * than kept as a bare import.
 */
export async function compileSolid(
  code: string,
  id: string,
  preset: unknown,
  options: SolidOptions = {}
): Promise<{ code: string; map: any } | undefined> {
  if (!isSolid(code)) return;

  // the map is inlined into the file it describes, so it names that file
  // relative to itself
  const sourceFileName = basename(id);
  let inputSourceMap;
  if (id.endsWith(".tsx")) {
    const stripped = await esbuildTransform(code, {
      loader: "tsx",
      jsx: "preserve",
      sourcemap: "external",
      sourcefile: sourceFileName,
    });
    code = stripped.code;
    inputSourceMap = JSON.parse(stripped.map);
  }

  const result = await transformAsync(code, {
    filename: id,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    sourceFileName,
    inputSourceMap,
    presets: [[preset, { generate: "dom", hydratable: false, ...options }]],
  });
  if (result?.code == null) {
    throw new Error(`babel-preset-solid produced nothing for ${id}`);
  }
  return { code: result.code, map: result.map };
}
