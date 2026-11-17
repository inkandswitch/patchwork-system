import {
  encodeHeads,
  stringifyAutomergeUrl,
  type DocumentId,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/registry/registry.js";
import {
  getRegistry,
  registerPlugins,
  pinPluginSources,
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

describe("shadowed registrations", () => {
  const DEV = "https://dev.example.test/tool/index.js";
  const dev = (url: string | undefined) =>
    url?.startsWith("https://dev.example.test/") ?? false;
  afterEach(() => pinPluginSources(undefined));

  it("brings back an overridden package's plugin when the overriding one goes", () => {
    const type = "test:shadow-returns";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "shared")], at(ID, v1));
    registerPlugins([plugin(type, "shared")], at(OTHER, v1));

    unregisterPlugins(`automerge:${OTHER}`);

    expect(registry.get("shared")?.importUrl).toBe(at(ID, v1));
    unregisterPlugins(`automerge:${ID}`);
    expect(registry.has("shared")).toBe(false);
  });

  it("brings it back when the overriding package drops the id", () => {
    const type = "test:shadow-dropped";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "shared")], at(ID, v1));
    registerPlugins([plugin(type, "shared"), plugin(type, "x")], DEV);

    registerPlugins([plugin(type, "x")], DEV);

    expect(registry.get("shared")?.importUrl).toBe(at(ID, v1));
    unregisterPlugins(DEV);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("keeps a package's place when it registers again", () => {
    const type = "test:shadow-in-place";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "tool")], at(ID, v1));
    registerPlugins([plugin(type, "tool")], at(OTHER, v1));
    const events: string[] = [];
    registry.on("registered", (p) => void events.push(`registered ${p.id}`));
    registry.on("changed", () => void events.push("changed"));

    registerPlugins([plugin(type, "tool")], at(ID, v2));

    expect(registry.get("tool")?.importUrl).toBe(at(OTHER, v1));
    expect(registry.get("tool")?.importUrl).toBe(at(OTHER, v1));
    expect(registry.shadows("tool").map((p) => p.importUrl)).toEqual([
      at(ID, v2),
    ]);
    expect(events).toEqual([]);
    unregisterPlugins(`automerge:${OTHER}`);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("updates the plugin in use in place", () => {
    const type = "test:shadow-top-update";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "tool")], at(ID, v1));
    registerPlugins([plugin(type, "tool")], at(OTHER, v1));
    const next = plugin(type, "tool");

    registerPlugins([next], at(OTHER, v2));

    expect(registry.get("tool")).toBe(next);
    expect(registry.shadows("tool")).toHaveLength(1);
    unregisterPlugins(`automerge:${OTHER}`);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("keeps a pinned package on top of one registering after it", () => {
    pinPluginSources(dev);
    const type = "test:shadow-pinned-first";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "tool")], DEV);
    const events: string[] = [];
    registry.on("registered", (p) => void events.push(`registered ${p.id}`));
    registry.on("changed", () => void events.push("changed"));

    registerPlugins([plugin(type, "tool")], at(ID, v1));
    registerPlugins([plugin(type, "tool")], at(ID, v2));

    expect(registry.get("tool")?.importUrl).toBe(DEV);
    expect(events).toEqual([]);

    unregisterPlugins(DEV);
    expect(registry.get("tool")?.importUrl).toBe(at(ID, v2));
    expect(events).toEqual(["registered tool", "changed"]);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("moves pinned packages to the top when they're pinned", () => {
    const type = "test:shadow-pin-later";
    const registry = getRegistry(type);
    registerPlugins([plugin(type, "tool")], DEV);
    registerPlugins([plugin(type, "tool")], at(ID, v1));
    expect(registry.get("tool")?.importUrl).toBe(at(ID, v1));

    pinPluginSources(dev);

    expect(registry.get("tool")?.importUrl).toBe(DEV);
    unregisterPlugins(DEV);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("pins in registries made after it's set", () => {
    pinPluginSources(dev);
    const type = "test:shadow-new-registry";
    registerPlugins([plugin(type, "tool")], DEV);
    registerPlugins([plugin(type, "tool")], at(ID, v1));

    expect(getRegistry(type).get("tool")?.importUrl).toBe(DEV);
    unregisterPlugins(DEV);
    unregisterPlugins(`automerge:${ID}`);
  });

  it("lists what each plugin in use shadows, in the order they'd take over", () => {
    const registry = new PluginRegistry<any>();
    registry.register(plugin("test:shadows", "a"), "https://a.test/a.js");
    registry.register(plugin("test:shadows", "a"), "https://b.test/b.js");
    registry.register(plugin("test:shadows", "a"), "https://c.test/c.js");
    registry.register(plugin("test:shadows", "d"), "https://a.test/a.js");

    expect(registry.all().map((p) => `${p.id} ${p.importUrl}`)).toEqual([
      "a https://c.test/c.js",
      "d https://a.test/a.js",
    ]);
    expect(registry.shadows("a").map((p) => p.importUrl)).toEqual([
      "https://b.test/b.js",
      "https://a.test/a.js",
    ]);
    expect(registry.shadows("d")).toEqual([]);
    expect(registry.shadows("nothing")).toEqual([]);
  });

  it("keeps a shadowed plugin loaded, so it isn't loaded again when it's back", async () => {
    const registry = new PluginRegistry<any>();
    let loads = 0;
    registry.register(
      {
        type: "test:loaded",
        id: "tool",
        name: "tool",
        load: async () => ++loads,
      } as any,
      "https://a.test/a.js"
    );
    await registry.load("tool");
    registry.register(plugin("test:loaded", "tool"), "https://b.test/b.js");

    registry.removeSource("https://b.test/b.js");

    expect((registry.get("tool") as any).module).toBe(1);
    expect((await registry.load("tool"))?.module).toBe(1);
    expect(loads).toBe(1);
  });

  it("remove takes the plugin in use, and the one it shadowed is in use", () => {
    const registry = new PluginRegistry<any>();
    registry.register(plugin("test:remove-top", "tool"), "https://a.test/a.js");
    registry.register(plugin("test:remove-top", "tool"), "https://b.test/b.js");

    expect(registry.remove("tool")).toBe(true);
    expect(registry.get("tool")?.importUrl).toBe("https://a.test/a.js");

    expect(registry.remove("tool")).toBe(true);
    expect(registry.has("tool")).toBe(false);
    expect(registry.remove("tool")).toBe(false);
  });
});
