import { afterEach, describe, expect, it, vi } from "vitest";
import { PackageDatabase, type PackageEntry } from "../src/package-db/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Added = Parameters<PackageDatabase["add"]>[0];

function entry(
  version: string,
  plugins: PackageEntry["plugins"] = [],
  more: Partial<Added> = {},
): Added {
  return {
    key: "https://x.test/p/",
    version,
    importUrl: "https://x.test/p/",
    plugins,
    addedBy: { by: "package-url" },
    ...more,
  };
}

describe("PackageDatabase", () => {
  it("add fires added, then replaced for a new version, synchronously", () => {
    const db = new PackageDatabase();
    const events: string[] = [];
    db.on("added", (e) => events.push(`added ${e.version}`));
    db.on("replaced", (e, previous) =>
      events.push(`replaced ${previous.version} ${e.version}`)
    );

    db.add(entry("a"));
    expect(events).toEqual(["added a"]);
    const b = db.add(entry("b"));
    expect(events).toEqual(["added a", "replaced a b"]);
    expect(db.get("https://x.test/p/")).toBe(b);
    expect(db.all()).toEqual([b]);
  });

  it("an addedBy array replaces the adders instead of merging into them", () => {
    const db = new PackageDatabase();
    db.add(entry("a"));
    db.add({ ...entry("a"), addedBy: { by: "suggested" } });

    const b = db.add({
      ...entry("b"),
      addedBy: [{ by: "package-list", entry: "site" }],
    });
    expect(b.addedBy).toEqual([{ by: "package-list", entry: "site" }]);
    const same = db.add({ ...entry("b"), addedBy: [{ by: "suggested" }] });
    expect(same).toBe(b);
    expect(b.addedBy).toEqual([{ by: "suggested" }]);
  });

  it("same version merges addedBy and fires nothing", () => {
    const db = new PackageDatabase();
    const first = db.add(entry("a"));
    const events: string[] = [];
    db.on("added", () => events.push("added"));
    db.on("replaced", () => events.push("replaced"));

    const second = db.add({
      ...entry("a"),
      addedBy: { by: "package-list", entry: "site" },
    });
    db.add(entry("a"));
    expect(events).toEqual([]);
    expect(second).toBe(first);
    expect(first.addedBy).toEqual([
      { by: "package-url" },
      { by: "package-list", entry: "site" },
    ]);
  });

  it("a live add at the same version replaces", async () => {
    const db = new PackageDatabase();
    db.add(entry("a", [{ type: "t", id: "x", load: async () => "old" }]));
    expect(await db.load(db.plugin("t", "x")!)).toBe("old");
    const replaced = vi.fn();
    db.on("replaced", replaced);

    const added = db.add({
      ...entry("a", [{ type: "t", id: "x", load: async () => "new" }]),
      addedBy: { by: "js", url: "https://x.test/p/", stack: "Error" },
    });
    expect(replaced).toHaveBeenCalledOnce();
    expect(db.get("https://x.test/p/")).toBe(added);
    expect(added.addedBy).toEqual([
      { by: "package-url" },
      { by: "js", url: "https://x.test/p/", stack: "Error" },
    ]);
    expect(await db.load(db.plugin("t", "x")!)).toBe("new");
  });

  it("a js add from the same url again keeps one js record, the newest", () => {
    const db = new PackageDatabase();
    const js = (stack: string) => ({
      ...entry("a", [{ type: "t", id: "x", load: async () => stack }]),
      addedBy: { by: "js" as const, url: "https://x.test/p/", stack },
    });
    db.add(js("first"));
    const second = db.add(js("second"));
    expect(second.addedBy).toEqual([
      { by: "js", url: "https://x.test/p/", stack: "second" },
    ]);
  });

  it("remove fires removed", () => {
    const db = new PackageDatabase();
    const added = db.add(entry("a"));
    const removed = vi.fn();
    db.on("removed", removed);

    expect(db.remove("https://x.test/p/")).toBe(true);
    expect(removed).toHaveBeenCalledWith(added);
    expect(db.get("https://x.test/p/")).toBeUndefined();
    expect(db.remove("https://x.test/p/")).toBe(false);
    expect(removed).toHaveBeenCalledOnce();
  });

  it("ids that collide: plugin() is the one added last, plugins() has both", () => {
    const db = new PackageDatabase();
    db.add(
      entry("a", [{ type: "t", id: "x", name: "one" }], {
        key: "https://x.test/one/",
        importUrl: "https://x.test/one/",
      }),
    );
    db.add(
      entry("a", [{ type: "t", id: "x", name: "two" }], {
        key: "https://x.test/two/",
        importUrl: "https://x.test/two/",
      }),
    );

    const view = db.plugin("t", "x")!;
    expect(view.name).toBe("two");
    expect(view.importUrl).toBe("https://x.test/two/");
    expect(view.package).toBe(db.get("https://x.test/two/"));
    expect(db.plugins("t").map((p) => p.name)).toEqual(["one", "two"]);
    expect(db.plugins("other")).toEqual([]);
  });

  it("legacy names are renamed", () => {
    const db = new PackageDatabase();
    db.add(
      entry("a", [
        { type: "patchwork:tool", id: "tool", supportedDataTypes: ["d"] },
        { type: "patchwork:dataType", id: "dt" },
      ]),
    );

    const tool = db.plugin("patchwork:tool", "tool")!;
    expect(tool.supportedDatatypes).toEqual(["d"]);
    expect(tool).not.toHaveProperty("supportedDataTypes");
    expect(db.plugin("patchwork:datatype", "dt")).toBeDefined();
    expect(db.plugin("patchwork:dataType", "dt")).toBeUndefined();
  });

  it("load imports a manifest export against base, once", async () => {
    const importModule = vi.fn(async () => ({ default: "the tool" }));
    const db = new PackageDatabase({ importModule });
    db.add(
      entry("a", [{ type: "t", id: "x", export: "./t" }], {
        base: "https://x.test/p/",
        packageJson: {
          exports: { "./t": "./t.js" },
          patchwork: { plugins: { t: { x: { export: "./t" } } } },
        },
      }),
    );

    const view = db.plugin("t", "x")!;
    const [one, two] = await Promise.all([db.load(view), db.load(view)]);
    expect(one).toBe("the tool");
    expect(two).toBe("the tool");
    expect(await db.load(db.plugin("t", "x")!)).toBe("the tool");
    expect(importModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith("https://x.test/p/t.js");
  });

  it("load of an index.js plugin picks type and id from the entry point", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ main: "index.js" })),
    );
    const importModule = vi.fn(async () => ({
      plugins: [
        { type: "t", id: "y", load: async () => "wrong id" },
        { type: "u", id: "x", load: async () => "wrong type" },
        { type: "t", id: "x", load: async () => "right" },
      ],
    }));
    const db = new PackageDatabase({ importModule });
    db.add(
      entry("a", [{ type: "t", id: "x" }], {
        base: "https://x.test/p/",
        packageJson: { main: "index.js" },
      }),
    );

    expect(await db.load(db.plugin("t", "x")!)).toBe("right");
    expect(importModule).toHaveBeenCalledWith("https://x.test/p/index.js");
  });

  it("a failed load is tried again", async () => {
    let calls = 0;
    const db = new PackageDatabase();
    db.add(
      entry("a", [
        {
          type: "t",
          id: "x",
          load: async () => {
            if (++calls === 1) throw new Error("nope");
            return "second time";
          },
        },
      ]),
    );

    const view = db.plugin("t", "x")!;
    const first = db.load(view);
    expect(db.isLoading(view)).toBe(true);
    await expect(first).rejects.toThrow("nope");
    expect(db.isLoading(view)).toBe(false);
    expect(await db.load(view)).toBe("second time");
    expect(db.isLoading(view)).toBe(false);
  });

  it("loaded fires with module set", async () => {
    const db = new PackageDatabase();
    db.add(entry("a", [{ type: "t", id: "x", load: async () => "mod" }]));
    const loaded = vi.fn();
    db.on("loaded", loaded);

    await db.load(db.plugin("t", "x")!);
    expect(loaded).toHaveBeenCalledOnce();
    expect(loaded.mock.calls[0][0]).toMatchObject({
      type: "t",
      id: "x",
      module: "mod",
    });
    expect(db.plugin("t", "x")!.module).toBe("mod");
  });
});
