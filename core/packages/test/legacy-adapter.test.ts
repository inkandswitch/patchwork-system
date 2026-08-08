import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyPluginModule,
  readLegacyPackage,
} from "../src/legacy-adapter.js";

const ORIGIN = "http://patchwork.test";

let blobs: Map<string, string>;

beforeEach(() => {
  blobs = new Map();
  let next = 0;
  vi.stubGlobal("location", { origin: ORIGIN, href: `${ORIGIN}/` });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: any) => {
    const url = `blob:${ORIGIN}/${next++}`;
    blobs.set(url, blob.source);
    return url;
  });
  vi.stubGlobal(
    "Blob",
    class {
      source: string;
      constructor(parts: string[]) {
        this.source = parts.join("");
      }
    }
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      String(input).endsWith("/package.json")
        ? ({
            ok: true,
            status: 200,
            json: async () => ({ exports: { ".": "./dist/index.js" } }),
          } as Response)
        : ({ ok: false, status: 404 } as Response)
    )
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("legacyPluginModule", () => {
  it("default-exports what the plugin's own loader resolves to", () => {
    const source = legacyPluginModule(
      "https://cdn.test/old/dist/index.js",
      "patchwork:tool",
      "old"
    );
    expect(source).toContain(
      'await import("https://cdn.test/old/dist/index.js")'
    );
    expect(source).toContain('p?.type === "patchwork:tool" && p?.id === "old"');
    expect(source).toContain("export default plugin.load");
  });
});

describe("readLegacyPackage", () => {
  const descriptors = [
    { id: "old", type: "patchwork:tool", name: "Old" },
    { id: "old", type: "patchwork:datatype" },
  ];

  it("announces as a normal manifest, with a blob URL per plugin", async () => {
    const pkg = await readLegacyPackage(
      "https://cdn.test/old",
      async () => descriptors
    );

    expect(pkg!.legacy).toBe(true);
    expect(pkg!.permissions).toEqual([]);
    expect(pkg!.plugins).toHaveLength(2);
    for (const plugin of pkg!.plugins) {
      expect(plugin.import).toMatch(/^blob:/);
      expect(plugin).not.toHaveProperty("load");
    }
    // A plugin id is only unique within its type, so the two must differ.
    expect(pkg!.plugins[0].import).not.toBe(pkg!.plugins[1].import);
    expect(pkg!.plugins[0].name).toBe("Old");
  });

  it("points each blob module at the resolved package entry point", async () => {
    const pkg = await readLegacyPackage(
      "https://cdn.test/entry-point",
      async () => descriptors
    );

    expect(blobs.get(pkg!.plugins[0].import)).toContain(
      'await import("https://cdn.test/entry-point/dist/index.js")'
    );
  });

  it("reuses one blob URL per plugin rather than making a new module each read", async () => {
    const url = "https://cdn.test/stable";
    const first = await readLegacyPackage(url, async () => descriptors);
    const second = await readLegacyPackage(url, async () => descriptors);

    expect(second!.plugins[0].import).toBe(first!.plugins[0].import);
  });

  it("warns that the package had to be imported", async () => {
    await readLegacyPackage("https://cdn.test/old", async () => descriptors);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("has no patchwork.json")
    );
  });

  it("is undefined when the package exports no plugins", async () => {
    expect(
      await readLegacyPackage("https://cdn.test/old", async () => [])
    ).toBeUndefined();
  });
});
