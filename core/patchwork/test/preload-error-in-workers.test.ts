import { build, type Plugin, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

import { preloadErrorInWorkers } from "../src/vite/service-worker-plugin.js";

// An entry with a dynamic import, which is what makes vite pull in its preload
// helper and wrap the import in it.
const entry: Plugin = {
  name: "entry",
  resolveId(id) {
    if (id === "entry" || id === "lazy") return `\0${id}`;
  },
  load(id) {
    if (id === "\0entry") return `globalThis.lazy = () => import("lazy");`;
    if (id === "\0lazy") return `export default 1;`;
  },
};

async function bundle(...plugins: Plugin[]): Promise<string> {
  const output = (await build({
    configFile: false,
    logLevel: "silent",
    plugins: [entry, ...plugins],
    build: {
      write: false,
      minify: false,
      modulePreload: { polyfill: false },
      rollupOptions: { input: "entry" },
    },
  })) as Rollup.RollupOutput;
  return output.output
    .filter((file): file is Rollup.OutputChunk => file.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
}

describe("preloadErrorInWorkers", () => {
  it("leaves vite's preload helper with a window to dispatch on", async () => {
    expect(await bundle()).toContain("window.dispatchEvent(");
  });

  it("dispatches a failed import's event on globalThis instead", async () => {
    const code = await bundle(preloadErrorInWorkers());
    expect(code).toContain("vite:preloadError");
    expect(code).not.toContain("window.dispatchEvent(");
    expect(code).toContain("globalThis.dispatchEvent(");
  });

  it("fails the build when the helper no longer calls window.dispatchEvent", async () => {
    const reworded: Plugin = {
      name: "reworded",
      enforce: "pre",
      transform(code, id) {
        if (id === "\0vite/preload-helper.js") {
          return code.replaceAll("window.dispatchEvent(", "self.dispatchEvent(");
        }
      },
    };
    await expect(bundle(reworded, preloadErrorInWorkers())).rejects.toThrow(
      /preloadErrorInWorkers/
    );
  });
});
