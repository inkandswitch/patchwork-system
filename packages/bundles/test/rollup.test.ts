import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rollup } from "rollup";
import { describe, expect, it } from "vitest";
import patchwork from "../src/rollup.js";
import { fixture } from "./fixture.js";

// rollup reads no TypeScript by itself, so this package is plain JS
const jsPackage = {
  "package.json": JSON.stringify({
    exports: {
      ".": { import: "./dist/index.js", source: "./src/index.js" },
      "./tool": { import: "./dist/tools/tool.js", source: "./src/tool.js" },
    },
  }),
  "src/index.js": `
    import { createSignal } from "solid-js";
    export const load = () => import("./tool.js");
    export const [count] = createSignal(0);
  `,
  "src/tool.js": `
    import { render } from "solid-js/web";
    export default (name) => render(() => name, document.body);
  `,
};

describe("the rollup plugin", () => {
  it("builds each export's source to its import", async () => {
    const root = fixture(jsPackage);
    const bundle = await rollup({
      logLevel: "silent",
      plugins: [patchwork({ root, pushwork: false })],
    });
    await bundle.write({ dir: join(root, "dist") });
    await bundle.close();

    const index = readFileSync(join(root, "dist", "index.js"), "utf8");
    expect(index).toMatch(/export \{/);
    expect(index).toMatch(/import\('\.\/tools\/tool\.js'\)/);
    expect(index).toMatch(/from 'solid-js'/);
    const tool = readFileSync(join(root, "dist", "tools", "tool.js"), "utf8");
    expect(tool).toMatch(/from 'solid-js\/web'/);
    expect(existsSync(join(root, "dist", "tools", "tool.js.map"))).toBe(true);
  });
});
