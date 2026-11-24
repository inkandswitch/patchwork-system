// @vitest-environment happy-dom
//
// Boot loads first the packages behind what was on screen last visit.
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashTools,
  planLoadOrder,
  preloadPlugins,
  readLoadOrder,
  recordLoadOrder,
  type LoadOrderHints,
  type LoadOrderRecorder,
} from "../src/load-order.js";

const tool = (id: string) => ({ type: "patchwork:tool", id });
const component = (id: string) => ({ type: "patchwork:component", id });
const KEY = "patchwork:load-order:test";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

describe("hashTools", () => {
  it("reads the frame and the tool, frame first", () => {
    expect(hashTools("#doc=automerge:abc&tool=essay&frame=threepane")).toEqual(
      [tool("threepane"), tool("essay")]
    );
  });

  it("reads nothing from a hash that names neither", () => {
    expect(hashTools("#doc=automerge:abc")).toEqual([]);
    expect(hashTools("")).toEqual([]);
  });
});

describe("planLoadOrder", () => {
  const hints: LoadOrderHints = {
    modules: {
      base: [tool("threepane"), tool("sidebar"), tool("essay")],
      sketch: [tool("sketch")],
      chat: [tool("chat"), component("avatar")],
      unseen: [tool("unseen")],
    },
    views: [
      [tool("threepane")],
      [tool("sidebar"), tool("sketch")],
      [component("avatar")],
    ],
  };

  it("puts the hash's tools first, then each depth of views, then nothing else", () => {
    expect(planLoadOrder(hints, [tool("chat")])).toEqual([
      { chat: [tool("chat"), component("avatar")] },
      { base: [tool("threepane"), tool("sidebar")] },
      { sketch: [tool("sketch")] },
    ]);
  });

  it("starts with the root view's when the hash names no tool", () => {
    expect(planLoadOrder(hints, [])).toEqual([
      { base: [tool("threepane"), tool("sidebar")] },
      { sketch: [tool("sketch")] },
      { chat: [component("avatar")] },
    ]);
  });

  it("plans nothing when the hash names a tool no package provided", () => {
    expect(planLoadOrder(hints, [tool("nowhere")])).toEqual([]);
  });

  it("skips a view's tool no package provided", () => {
    const plan = planLoadOrder(
      { ...hints, views: [[tool("threepane"), tool("suggested")]] },
      []
    );
    expect(plan).toEqual([{ base: [tool("threepane")] }]);
  });

  it("loads every package that provides a tool", () => {
    const plan = planLoadOrder(
      { modules: { a: [tool("x")], b: [tool("x")] }, views: [[tool("x")]] },
      []
    );
    expect(plan).toEqual([{ a: [tool("x")], b: [tool("x")] }]);
  });

  it("plans nothing from nothing", () => {
    expect(planLoadOrder({ modules: {}, views: [] }, [])).toEqual([]);
  });
});

describe("readLoadOrder", () => {
  it("reads nothing from nothing, junk, or another version", () => {
    const storage = memoryStorage();
    expect(readLoadOrder(storage, KEY)).toEqual({ modules: {}, views: [] });
    storage.setItem(KEY, "{nope");
    expect(readLoadOrder(storage, KEY)).toEqual({ modules: {}, views: [] });
    storage.setItem(KEY, JSON.stringify({ version: 0, modules: { a: [] } }));
    expect(readLoadOrder(storage, KEY)).toEqual({ modules: {}, views: [] });
  });

  it("drops anything that isn't a plugin", () => {
    const storage = memoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        modules: { a: [tool("x"), { id: 3 }, "y"] },
        views: [[tool("x"), null]],
      })
    );
    expect(readLoadOrder(storage, KEY)).toEqual({
      modules: { a: [tool("x")] },
      views: [[tool("x")]],
    });
  });
});

describe("recordLoadOrder", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let recorder: LoadOrderRecorder;
  const stored = () => JSON.parse(storage.items.get(KEY) ?? "null");

  function view(parent: Element | ShadowRoot): HTMLElement {
    const element = document.createElement("patchwork-view");
    parent.append(element);
    return element;
  }

  function mount(element: HTMLElement, detail: object) {
    element.dispatchEvent(
      new CustomEvent("patchwork:mounted", {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    storage = memoryStorage();
  });

  afterEach(() => {
    recorder?.stop();
    document.body.textContent = "";
    vi.useRealTimers();
  });

  it("writes down the tools and components each package provided", async () => {
    recorder = recordLoadOrder(storage, KEY, { modules: {}, views: [] });
    recorder.loaded("base", {
      plugins: [
        { type: "patchwork:tool", id: "essay", name: "Essay", load() {} },
        { type: "patchwork:datatype", id: "essay" },
        { type: "patchwork:component", id: "avatar" },
      ],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().modules).toEqual({
      base: [tool("essay"), component("avatar")],
    });

    recorder.unloaded("base");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().modules).toEqual({});
  });

  it("forgets packages that left the list", async () => {
    recorder = recordLoadOrder(storage, KEY, {
      modules: { kept: [tool("a")], gone: [tool("b")] },
      views: [],
    });
    recorder.keepOnly(["kept", "new"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().modules).toEqual({ kept: [tool("a")] });
  });

  it("writes down mounted views by depth, through shadow roots", async () => {
    recorder = recordLoadOrder(storage, KEY, { modules: {}, views: [] });
    const root = view(document.body);
    const content = document.createElement("div");
    root.append(content);
    const sidebar = view(content);
    const host = document.createElement("div");
    content.append(host);
    const shadowed = view(host.attachShadow({ mode: "open" }));
    const inner = view(shadowed);

    mount(root, { url: "automerge:a", toolId: "threepane" });
    mount(sidebar, { url: "automerge:b", toolId: "sidebar" });
    mount(shadowed, { url: "automerge:c", toolId: "essay" });
    mount(inner, { componentId: "avatar" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(stored().views).toEqual([
      [tool("threepane")],
      [tool("sidebar"), tool("essay")],
      [component("avatar")],
    ]);
  });

  it("drops views that went", async () => {
    recorder = recordLoadOrder(storage, KEY, { modules: {}, views: [] });
    const root = view(document.body);
    const inner = view(root);
    mount(root, { url: "automerge:a", toolId: "threepane" });
    mount(inner, { url: "automerge:b", toolId: "essay" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().views).toHaveLength(2);

    inner.remove();
    root.dispatchEvent(
      new CustomEvent("patchwork:unmounted", {
        detail: { url: "automerge:b", toolId: "essay" },
        bubbles: true,
        composed: true,
      })
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().views).toEqual([[tool("threepane")]]);
  });

  it("keeps last visit's views when the page goes before any mounted", async () => {
    const views = [[tool("threepane")]];
    recorder = recordLoadOrder(storage, KEY, { modules: {}, views });
    recorder.loaded("base", { plugins: [tool("threepane")] });
    window.dispatchEvent(new Event("pagehide"));
    expect(stored().views).toEqual(views);
  });

  it("writes straight away when the page is hidden", () => {
    recorder = recordLoadOrder(storage, KEY, { modules: {}, views: [] });
    mount(view(document.body), { url: "automerge:a", toolId: "threepane" });
    expect(stored()).toBe(null);
    window.dispatchEvent(new Event("pagehide"));
    expect(stored().views).toEqual([[tool("threepane")]]);
  });
});

describe("preloadPlugins", () => {
  it("loads a planned plugin as soon as it registers, until told to stop", async () => {
    const registry = getRegistry("patchwork:tool");
    const load = vi.fn(async () => () => () => {});
    let stop!: () => void;
    preloadPlugins(
      [{ pkg: [tool("preload-early")] }],
      new Promise<void>((resolve) => (stop = resolve))
    );
    registry.register(
      { type: "patchwork:tool", id: "preload-early", name: "Early", load } as any,
      "pkg"
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    stop();
    await new Promise((r) => setTimeout(r, 0));
    const late = vi.fn(async () => () => () => {});
    registry.register(
      { type: "patchwork:tool", id: "preload-early", name: "Early", load: late } as any,
      "pkg"
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(late).not.toHaveBeenCalled();
  });
});
