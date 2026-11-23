import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importPackageFromHttpUrl,
  pluginsFromManifest,
} from "../src/packages.js";

const manifest = {
  name: "manifest-package",
  main: "./build/main.js",
  exports: {
    ".": "./build/main.js",
    "./tools/whatever": {
      patchwork: "./build/patchwork.js",
      import: "./build/import.js",
    },
    "./datatypes/named": "./build/named.js",
  },
  patchwork: {
    plugins: {
      "patchwork:tool": {
        "some-id": {
          name: "hehe",
          supportedDatatypes: ["a", "b"],
          export: "./tools/whatever",
        },
      },
      "patchwork:datatype": {
        named: { name: "Named", export: "./datatypes/named" },
        "no-export": { name: "No export" },
      },
    },
  },
};

const fixtureBase = new URL("./fixtures/manifest-package/", import.meta.url)
  .href;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("patchwork.plugins in package.json", () => {
  it("lists the plugins from package.json without importing the entry point", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => manifest,
    }));
    vi.stubGlobal("fetch", fetch);

    // ./build/main.js doesn't exist at this origin: importing it would throw.
    const mod = await importPackageFromHttpUrl(
      "https://cdn.example.test/manifest-package/"
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "https://cdn.example.test/manifest-package/package.json"
    );
    const descriptions = mod.plugins.map(
      ({ load, ...description }: Record<string, unknown>) => {
        expect(load).toBeTypeOf("function");
        return description;
      }
    );
    expect(descriptions).toEqual([
      {
        type: "patchwork:tool",
        id: "some-id",
        name: "hehe",
        supportedDatatypes: ["a", "b"],
      },
      { type: "patchwork:datatype", id: "named", name: "Named" },
      { type: "patchwork:datatype", id: "no-export", name: "No export" },
    ]);
  });

  it("loads a plugin from its export, under the first matching condition", async () => {
    const [tool] = pluginsFromManifest(manifest, fixtureBase);
    expect(await tool.load()).toBe("patchwork build");

    const [importOnly] = pluginsFromManifest(manifest, fixtureBase, [
      "browser",
      "import",
    ]);
    expect(await importOnly.load()).toBe("import build");
  });

  it("loads the whole module when the export has no default", async () => {
    const named = pluginsFromManifest(manifest, fixtureBase).find(
      (p) => p.id === "named"
    )!;
    const loaded = await named.load();
    expect(loaded.getTitle()).toBe("named");
  });

  it("fails the load, not discovery, of a plugin without an export", async () => {
    const noExport = pluginsFromManifest(manifest, fixtureBase).find(
      (p) => p.id === "no-export"
    )!;
    await expect(noExport.load()).rejects.toThrow(/has no "export"/);
  });

  it("still imports the entry point of a package without patchwork.plugins", async () => {
    const { patchwork: _, ...plain } = manifest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => plain }))
    );
    await expect(
      importPackageFromHttpUrl("https://cdn.example.test/manifest-package/")
    ).rejects.toThrow();
  });
});
