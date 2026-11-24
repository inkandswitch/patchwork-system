import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import patchwork from "../src/vite.js";
import { describe, expect, it } from "vitest";
import { fixture, ownSolid, plainPackage } from "./fixture.js";

const viteBuild = (root: string, config: object = {}) =>
  build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [patchwork({ pushwork: false })],
    ...config,
  });

describe("the vite plugin", () => {
  it("builds each export's source to its import", async () => {
    const root = fixture(plainPackage);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "stale.js"), "old build");

    await viteBuild(root);

    expect(existsSync(join(root, "dist", "stale.js"))).toBe(false);
    const index = readFileSync(join(root, "dist", "index.js"), "utf8");
    // the entry keeps its exports, and loads the tool by a relative path
    expect(index).toMatch(/export\s*\{/);
    expect(index).toMatch(/import\("\.\/tools\/tool\.js"\)/);
    expect(index).toMatch(/from\s*"solid-js"/);

    const tool = readFileSync(join(root, "dist", "tools", "tool.js"), "utf8");
    expect(tool).toMatch(/toUpperCase/);
    expect(existsSync(join(root, "dist", "tools", "tool.js.map"))).toBe(true);
  });

  it("keeps a library build's own entry", async () => {
    const root = fixture(plainPackage);
    await viteBuild(root, {
      build: {
        lib: { entry: "src/index.ts", formats: ["es"], fileName: "lib" },
      },
    });
    expect(existsSync(join(root, "dist", "lib.js"))).toBe(true);
    expect(existsSync(join(root, "dist", "index.js"))).toBe(false);
    // and still leaves the importmap's modules out
    const out = readFileSync(join(root, "dist", "lib.js"), "utf8");
    expect(out).toMatch(/from\s*"solid-js"/);
  });

  it("bundles the host's modules it's told to", async () => {
    const root = fixture({ ...plainPackage, ...ownSolid });
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [patchwork({ pushwork: false, bundle: ["solid-js"] })],
    });
    const index = readFileSync(join(root, "dist", "index.js"), "utf8");
    expect(index).not.toMatch(/from\s*"solid-js"/);
  });
});
