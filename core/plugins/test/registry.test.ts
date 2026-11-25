import {
  encodeHeads,
  stringifyAutomergeUrl,
  type DocumentId,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { packages, sourceOf } from "@inkandswitch/patchwork-filesystem";
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/registry/registry.js";
import {
  getRegistry,
  registerPlugins,
  unregisterPlugins,
} from "../src/registry/index.js";

const ID = "2uZrhZ7G2NJxryZSMWSdDNFCke8C";
const OTHER = "4NMNnkMhL8jXrdJ9jamS58PAVdXu";

// Heads of two versions, shaped as automerge's are, to pin urls of the
// documents above to.
const v1 = encodeHeads(["a1".repeat(32)] as never);
const v2 = encodeHeads(["b2".repeat(32)] as never);
const at = (id: string, heads: UrlHeads) =>
  stringifyAutomergeUrl({ documentId: id as DocumentId, heads });

const plugin = (type: string, id: string) =>
  ({ type, id, name: id, load: async () => ({}) }) as any;

describe("registerPlugins and unregisterPlugins", () => {
  it("unregisters a package's plugins at any heads", () => {
    const type = "test:unregister-any-heads";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "a")], at(ID, v1));
    registerPlugins([plugin(type, "b")], at(OTHER, v2));

    unregisterPlugins(`automerge:${ID}`);

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    unregisterPlugins(`automerge:${OTHER}`);
  });

  it("unregisters by a url at heads too", () => {
    const type = "test:unregister-with-heads";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "a")], at(ID, v1));

    unregisterPlugins(at(ID, v2));

    expect(registry.has("a")).toBe(false);
  });

  it("compares non-automerge urls exactly", () => {
    const type = "test:unregister-exact";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "a")], "https://example.test/a.js");

    unregisterPlugins("https://example.test/b.js");
    expect(registry.has("a")).toBe(true);

    unregisterPlugins("https://example.test/a.js");
    expect(registry.has("a")).toBe(false);
  });

  it("treats service worker urls at different heads as one package", () => {
    const type = "test:unregister-sw";
    const registry = getRegistry(type);
    registerPlugins(
      [plugin(type, "a")],
      `http://localhost/${encodeURIComponent(at(ID, v1))}/path/entry.js`
    );

    unregisterPlugins(`http://localhost/automerge%3A${ID}/path/entry.js`);

    expect(registry.has("a")).toBe(false);
  });

  it("doesn't take a plain url with the document's id in it for the package", () => {
    const type = "test:unregister-sw-plain";
    const registry = getRegistry(type);
    registerPlugins(
      [plugin(type, "a")],
      `http://localhost/${encodeURIComponent(at(ID, v1))}/path/entry.js`
    );

    unregisterPlugins(`http://localhost/${ID}/path/entry.js`);

    expect(registry.has("a")).toBe(true);
    unregisterPlugins(`http://localhost/automerge%3A${ID}/path/entry.js`);
  });

  it("drops a plugin the next version of the package no longer provides", () => {
    const type = "test:reload-drops";
    const registry = getRegistry(type);
    registerPlugins(
      [plugin(type, "kept"), plugin(type, "renamed-old")],
      at(ID, v1)
    );

    registerPlugins(
      [plugin(type, "kept"), plugin(type, "renamed-new")],
      at(ID, v2)
    );

    expect(registry.has("renamed-old")).toBe(false);
    expect(registry.has("renamed-new")).toBe(true);
    expect(registry.get("kept")?.importUrl).toBe(at(ID, v2));
    unregisterPlugins(`automerge:${ID}`);
  });

  it("replaces plugins the new version still provides without removing them", () => {
    const type = "test:reload-in-place";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "kept")], at(ID, v1));
    const removed: string[] = [];
    registry.on("removed", (id) => void removed.push(id));

    registerPlugins([plugin(type, "kept")], at(ID, v2));

    expect(removed).toEqual([]);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("leaves a plugin another package has since overridden", () => {
    const type = "test:reload-overridden";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "shared")], at(ID, v1));
    registerPlugins([plugin(type, "shared")], at(OTHER, v1));

    registerPlugins([], at(ID, v2));

    expect(registry.get("shared")?.importUrl).toBe(at(OTHER, v1));
    unregisterPlugins(`automerge:${OTHER}`);
  });
});

describe("registerPlugins and the package database", () => {
  it("registerPlugins adds a js entry with a stack", () => {
    const url = "https://example.test/js-entry.js";
    registerPlugins([plugin("test:db-js", "a")], url);

    const entry = packages.get(sourceOf(url)!)!;
    expect(entry.importUrl).toBe(url);
    expect(entry.version).toBe(url);
    expect(entry.plugins.map((p) => p.id)).toEqual(["a"]);
    expect(entry.addedBy).toHaveLength(1);
    expect(entry.addedBy[0]).toMatchObject({ by: "js", url });
    expect((entry.addedBy[0] as { stack: string }).stack).toContain("Error");
    unregisterPlugins(url);
    packages.remove(sourceOf(url)!);
  });

  it("registerPlugins after the watcher's add at the same url leaves the entry alone", () => {
    const url = at(ID, v1);
    const key = sourceOf(url)!;
    const listed = packages.add({
      key,
      version: "a1",
      importUrl: url,
      plugins: [{ type: "test:db-listed", id: "a" }],
      addedBy: { by: "package-list", entry: `automerge:${ID}` },
    });

    registerPlugins([plugin("test:db-listed", "a")], url);

    const entry = packages.get(key)!;
    expect(entry).toBe(listed);
    expect(entry.addedBy).toEqual([
      { by: "package-list", entry: `automerge:${ID}` },
    ]);
    expect(entry.plugins[0].load).toBeUndefined();
    unregisterPlugins(url);
    packages.remove(key);
  });

  it("registerPlugins twice from js at one url: the second wins", () => {
    const url = "https://example.test/twice.js";
    registerPlugins([plugin("test:db-twice", "first")], url);
    registerPlugins([plugin("test:db-twice", "second")], url);

    const entry = packages.get(sourceOf(url)!)!;
    expect(entry.plugins.map((p) => p.id)).toEqual(["second"]);
    expect(entry.addedBy).toHaveLength(1);
    expect(entry.addedBy[0]).toMatchObject({ by: "js", url });
    unregisterPlugins(url);
    packages.remove(sourceOf(url)!);
  });
});

describe("PluginRegistry.loadWhenReady", () => {
  const description = (id: string, load: () => Promise<unknown>) =>
    ({ type: "test:when-ready", id, name: id, load }) as any;

  it("waits for a plugin that is not registered yet", async () => {
    const registry = new PluginRegistry<any>();
    const ready = registry.loadWhenReady("late");

    registry.register(
      description("late", async () => "impl"),
      "u"
    );

    expect((await ready).module).toBe("impl");
  });

  it("keeps trying when the plugin is re-registered while it loads", async () => {
    const registry = new PluginRegistry<any>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registry.register(
      description("swapped", async () => {
        await gate;
        return "v1";
      }),
      "u1"
    );

    const ready = registry.loadWhenReady("swapped");
    registry.register(
      description("swapped", async () => "v2"),
      "u2"
    );
    release();

    expect((await ready).module).toBe("v2");
  });

  it("waits for a registration when the plugin is removed while it loads", async () => {
    const registry = new PluginRegistry<any>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registry.register(
      description("gone", async () => {
        await gate;
        return "v1";
      }),
      "u1"
    );

    const ready = registry.loadWhenReady("gone");
    registry.remove("gone");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.register(
      description("gone", async () => "v2"),
      "u2"
    );

    expect((await ready).module).toBe("v2");
  });
});
