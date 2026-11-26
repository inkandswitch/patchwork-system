import {
  Repo,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importPackageFromHttpUrl,
  importPackageWithJson,
  pluginsFromManifest,
  readPackageJson,
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
      text: async () => JSON.stringify(manifest),
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

  it("lists a plugin without an export, and its load does nothing", async () => {
    const noExport = pluginsFromManifest(manifest, fixtureBase).find(
      (p) => p.id === "no-export"
    )!;
    await expect(noExport.load()).resolves.toBeUndefined();
  });

  it("fails only the plugin whose export matches nothing in exports", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      ...manifest,
      patchwork: {
        plugins: {
          "patchwork:tool": {
            missing: { name: "Missing", export: "./tools/missing" },
            "some-id": { name: "hehe", export: "./tools/whatever" },
          },
        },
      },
    };
    const plugins = pluginsFromManifest(broken, fixtureBase);
    expect(plugins.map((p) => p.id)).toEqual(["missing", "some-id"]);
    const matchesNothing =
      /"\.\/tools\/missing", which matches nothing in its "exports"/;
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(matchesNothing));

    const [missing, fine] = plugins;
    await expect(missing.load()).rejects.toThrow(matchesNothing);
    await expect(fine.load()).resolves.toBeDefined();
    warn.mockRestore();
  });

  it("resolves a relative style against the package, and leaves a URL alone", () => {
    const themed = {
      ...manifest,
      patchwork: {
        plugins: {
          "patchwork:theme": {
            gloom: { name: "Gloom", style: "./gloom.css" },
            far: { name: "Far", style: "https://example.com/far.css" },
          },
        },
      },
    };
    const [gloom, far] = pluginsFromManifest(themed, fixtureBase);
    expect(gloom.style).toBe(new URL("gloom.css", fixtureBase).href);
    expect(far.style).toBe("https://example.com/far.css");
  });

  it("resolves an export from a string exports field", async () => {
    const plain = {
      name: "plain",
      exports: "./build/named.js",
      patchwork: {
        plugins: { "patchwork:datatype": { named: { export: "." } } },
      },
    };
    const [named] = pluginsFromManifest(plain, fixtureBase);
    expect((await named.load()).getTitle()).toBe("named");
  });

  it("still imports the entry point of a package without patchwork.plugins", async () => {
    const { patchwork: _, ...plain } = manifest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(plain) }))
    );
    await expect(
      importPackageFromHttpUrl("https://cdn.example.test/manifest-package/")
    ).rejects.toThrow();
  });
});

describe("readPackageJson", () => {
  const body = JSON.stringify(manifest);
  const stubFetch = () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => manifest,
    }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("http version is the sha-256 of the body", async () => {
    stubFetch();
    const url = "https://cdn.example.test/manifest-package/";
    const pkg = await readPackageJson(url);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body)
    );
    expect(pkg).toEqual({
      importUrl: url,
      base: url,
      packageJson: manifest,
      version: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
    });
  });

  it("automerge version is the url's heads", async () => {
    stubFetch();
    vi.stubGlobal("location", new URL("http://localhost/"));
    const handle = await new Repo({ network: [] }).create2({ a: 1 });
    const url = stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(handle.url).documentId,
      heads: handle.heads()!,
    });
    const pkg = await readPackageJson(url);
    expect(pkg?.version).toBe(url.split("#")[1]);
    expect(pkg?.version).not.toBe("");
    expect(pkg?.packageJson).toEqual(manifest);
  });

  it("a module url has no package.json", async () => {
    const fetch = stubFetch();
    expect(
      await readPackageJson("https://cdn.example.test/x/main.js")
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("importPackageWithJson fetches package.json once", async () => {
    const fetch = stubFetch();
    const result = await importPackageWithJson(
      "https://cdn.example.test/manifest-package/"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.plugins).toHaveLength(3);
    expect(result.package?.packageJson).toEqual(manifest);
  });
});
