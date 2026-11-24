import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import patchwork from "../src/esbuild.js";
import { fixture, ownSolid, plainPackage, solidPackage } from "./fixture.js";

const build = (root: string, options: esbuild.BuildOptions = {}) =>
  esbuild.build({
    absWorkingDir: root,
    logLevel: "silent",
    ...options,
    plugins: [patchwork({ pushwork: false }), ...(options.plugins ?? [])],
  });

describe("the esbuild plugin", () => {
  it("builds each export's source to its import", async () => {
    const root = fixture(plainPackage);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "stale.js"), "old build");

    const result = await build(root);
    expect(result.errors).toEqual([]);

    expect(existsSync(join(root, "dist", "stale.js"))).toBe(false);
    expect(existsSync(join(root, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(root, "dist", "index.js.map"))).toBe(true);
    const tool = readFileSync(join(root, "dist", "tools", "tool.js"), "utf8");
    // solid-js is left for the host's importmap
    expect(tool).toMatch(/from "solid-js"/);
  });

  it("compiles no JSX of its own", async () => {
    const root = fixture({
      "package.json": JSON.stringify({
        exports: {
          ".": { import: "./dist/index.js", source: "./src/index.tsx" },
        },
        dependencies: { "solid-js": "^1.9.9" },
      }),
      "src/index.tsx": `export const a = <div />;`,
    });
    await build(root, { jsxFactory: "h" });
    const out = readFileSync(join(root, "dist", "index.js"), "utf8");
    expect(out).toMatch(/h\("div"/);
  });

  it("bundles the host's modules it's told to", async () => {
    const root = fixture({ ...plainPackage, ...ownSolid });
    const result = await esbuild.build({
      absWorkingDir: root,
      logLevel: "silent",
      plugins: [patchwork({ pushwork: false, bundle: ["solid-js"] })],
    });
    expect(result.errors).toEqual([]);
    for (const file of ["index.js", "tools/tool.js"]) {
      const out = readFileSync(join(root, "dist", file), "utf8");
      expect(out).not.toMatch(/from "solid-js"/);
    }
    // its own copy is in the build, in a chunk the entries share
    const chunks = readdirSync(join(root, "dist")).filter((f) =>
      f.endsWith(".js")
    );
    expect(
      chunks.some((f) =>
        readFileSync(join(root, "dist", f), "utf8").includes("v = n")
      )
    ).toBe(true);
  });

  it("keeps the options the build sets", async () => {
    const root = fixture(solidPackage);
    await build(root, {
      entryPoints: ["src/index.ts"],
      outdir: "out",
      splitting: false,
      external: ["./tool.tsx"],
    });
    expect(existsSync(join(root, "out", "index.js"))).toBe(true);
    expect(existsSync(join(root, "dist"))).toBe(false);
    const out = readFileSync(join(root, "out", "index.js"), "utf8");
    expect(out).toMatch(/from "solid-js"/);
  });

  it("finds the package from `root`", async () => {
    const root = fixture(plainPackage);
    const result = await esbuild.build({
      logLevel: "silent",
      plugins: [patchwork({ root, pushwork: false })],
    });
    expect(result.errors).toEqual([]);
    expect(existsSync(join(root, "dist", "tools", "tool.js"))).toBe(true);
  });

  it("says what to add when no export has a source", async () => {
    const root = fixture({
      "package.json": JSON.stringify({ exports: { ".": "./dist/index.js" } }),
    });
    await expect(build(root)).rejects.toThrow(/no export with a `source`/);
  });
});
