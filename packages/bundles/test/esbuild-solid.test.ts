import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import patchwork from "../src/esbuild.js";
import solid1 from "../src/esbuild-solid1.js";
import solid2 from "../src/esbuild-solid2.js";
import { fixture, ownSolid, solidPackage } from "./fixture.js";

describe("the Solid 1 esbuild plugin", () => {
  it("compiles Solid 1 JSX for the host's solid-js/web", async () => {
    const root = fixture(solidPackage);
    const result = await esbuild.build({
      absWorkingDir: root,
      logLevel: "silent",
      plugins: [patchwork({ pushwork: false }), solid1()],
    });
    expect(result.errors).toEqual([]);

    const tool = readFileSync(join(root, "dist", "tools", "tool.js"), "utf8");
    expect(tool).toMatch(/from "solid-js\/web"/);
    expect(tool).toMatch(/template\(/);
    expect(tool).not.toMatch(/\{label\(/);
    // its own imports are bundled
    expect(tool).toMatch(/toUpperCase/);

    const map = JSON.parse(
      readFileSync(join(root, "dist", "tools", "tool.js.map"), "utf8")
    );
    const index = map.sources.indexOf("../../src/tool.tsx");
    expect(index).not.toBe(-1);
    // the source as written, not as babel left it
    expect(map.sourcesContent[index]).toMatch(/<div class="tool">/);
  });

  it("leaves a file with another jsxImportSource to esbuild", async () => {
    const root = fixture({
      ...solidPackage,
      "package.json": JSON.stringify({
        exports: {
          ".": { import: "./dist/react.js", source: "./src/react.tsx" },
        },
      }),
    });
    const result = await esbuild.build({
      absWorkingDir: root,
      logLevel: "silent",
      jsx: "automatic",
      external: ["react"],
      plugins: [patchwork({ pushwork: false }), solid1()],
    });
    expect(result.errors).toEqual([]);
    const out = readFileSync(join(root, "dist", "react.js"), "utf8");
    expect(out).toMatch(/react\/jsx-runtime/);
    expect(out).not.toMatch(/solid-js/);
  });
});

describe("the Solid 2 esbuild plugin", () => {
  it("compiles Solid 2 JSX for @solidjs/web, with its own solid-js", async () => {
    const root = fixture({ ...solidPackage, ...ownSolid });
    const result = await esbuild.build({
      absWorkingDir: root,
      logLevel: "silent",
      // the test has no @solidjs/web to bundle
      external: ["@solidjs/web"],
      plugins: [solid2(), patchwork({ pushwork: false, bundle: ["solid-js"] })],
    });
    expect(result.errors).toEqual([]);

    const tool = readFileSync(join(root, "dist", "tools", "tool.js"), "utf8");
    expect(tool).toMatch(/from "@solidjs\/web"/);
    expect(tool).not.toMatch(/solid-js\/web/);
    expect(tool).not.toMatch(/from "solid-js"/);
  });

  it("refuses to build against the host's Solid 1", async () => {
    const root = fixture(solidPackage);
    await expect(
      esbuild.build({
        absWorkingDir: root,
        logLevel: "silent",
        plugins: [patchwork({ pushwork: false }), solid2()],
      })
    ).rejects.toThrow(/gets the host's Solid 1/);
  });
});
