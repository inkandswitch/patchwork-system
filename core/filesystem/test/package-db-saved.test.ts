import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { PackageDatabase } from "../src/package-db/index.js";

type Added = Parameters<PackageDatabase["add"]>[0];

function entry(version: string, more: Partial<Added> = {}): Added {
  return {
    key: "https://x.test/p/",
    version,
    importUrl: "https://x.test/p/",
    plugins: [{ type: "patchwork:tool", id: "t" }],
    addedBy: { by: "package-list", entry: "x" },
    ...more,
  };
}

let n = 0;
const name = () => `patchwork-packages test-${n++}`;

describe("saved package database", () => {
  it("an opened database comes back on the next open", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    first.add(entry("v1"));
    first.add(entry("v2"));
    await first.versions(first.get("https://x.test/p/")!.key);

    const second = new PackageDatabase();
    const added: string[] = [];
    second.on("added", (e) => added.push(e.version));
    await second.open(dbName);
    await second.ready;
    expect(second.get("https://x.test/p/")?.version).toBe("v2");
    expect(second.get("https://x.test/p/")?.addedBy).toEqual([
      { by: "package-list", entry: "x" },
    ]);
    expect(added).toEqual(["v2"]);
  });

  it("accounts stay apart", async () => {
    const a = new PackageDatabase();
    await a.open(name());
    a.add(entry("v1"));
    await a.versions("https://x.test/p/");
    const b = new PackageDatabase();
    await b.open(name());
    expect(b.all()).toEqual([]);
  });

  it("live entries aren't saved", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    first.add(entry("v1", { plugins: [{ type: "t", id: "a", load: async () => 1 }] }));
    expect(await first.versions("https://x.test/p/")).toEqual([]);
    const second = new PackageDatabase();
    await second.open(dbName);
    expect(second.all()).toEqual([]);
  });

  it("only listed entries are saved", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    const at = (path: string) => ({
      key: `https://x.test/${path}/`,
      importUrl: `https://x.test/${path}/`,
    });
    first.add(entry("v1", { ...at("viewed"), addedBy: { by: "package-url" } }));
    first.add(entry("v1", { ...at("suggested"), addedBy: { by: "suggested" } }));
    first.add(entry("v1", at("listed")));
    await first.versions("https://x.test/listed/");
    const second = new PackageDatabase();
    await second.open(dbName);
    expect(second.all().map((e) => e.key)).toEqual(["https://x.test/listed/"]);
  });

  it("open with hydrate false saves but doesn't load saved entries", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    first.add(entry("v1"));
    await first.versions("https://x.test/p/");

    const second = new PackageDatabase();
    const added = vi.fn();
    second.on("added", added);
    const opened = second.open(dbName, { hydrate: false });
    await second.ready;
    await opened;
    expect(second.all()).toEqual([]);
    expect(added).not.toHaveBeenCalled();
    second.add(entry("v2"));
    expect((await second.versions("https://x.test/p/")).map((e) => e.version))
      .toEqual(["v1", "v2"]);

    const third = new PackageDatabase();
    await third.open(dbName);
    expect(third.get("https://x.test/p/")?.version).toBe("v2");
  });

  it("removed packages aren't current but keep their versions", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    first.add(entry("v1"));
    first.add(entry("v2"));
    first.remove("https://x.test/p/");
    expect((await first.versions("https://x.test/p/")).map((e) => e.version))
      .toEqual(["v1", "v2"]);
    const second = new PackageDatabase();
    await second.open(dbName);
    expect(second.all()).toEqual([]);
  });

  it("entries added before open are saved by open", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    first.add(entry("v1"));
    await first.open(dbName);
    const second = new PackageDatabase();
    await second.open(dbName);
    expect(second.get("https://x.test/p/")?.version).toBe("v1");
  });

  it("merging addedBy into the same version is saved", async () => {
    const dbName = name();
    const first = new PackageDatabase();
    await first.open(dbName);
    first.add(entry("v1"));
    first.add(entry("v1", { addedBy: { by: "suggested" } }));
    await first.versions("https://x.test/p/");
    const second = new PackageDatabase();
    await second.open(dbName);
    expect(second.get("https://x.test/p/")?.addedBy).toHaveLength(2);
  });

  it("announce reaches onNews in another database", async () => {
    const a = new PackageDatabase();
    const b = new PackageDatabase();
    const heard = new Promise<string>((resolve) => {
      const off = b.onNews((key) => {
        off();
        resolve(key);
      });
    });
    a.announce("https://x.test/p/");
    expect(await heard).toBe("https://x.test/p/");
  });
});
