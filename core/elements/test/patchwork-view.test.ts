import { Repo } from "@automerge/automerge-repo";
import { importPackage } from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The suggested-import tests decide what a package import does; nothing here
// should reach the network.
vi.mock("@inkandswitch/patchwork-filesystem", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPackage: vi.fn(async () => {
    throw new Error("importPackage not stubbed for this test");
  }),
}));

import {
  registerPatchworkViewElement,
  type ComponentDescription,
} from "../src/patchwork-view.js";

const registry = getRegistry<ComponentDescription>("patchwork:component");
const toolRegistry = getRegistry("patchwork:tool");

type Counters = { mounts: number; cleanups: number };

function registerComponent(id: string): Counters {
  const counters: Counters = { mounts: 0, cleanups: 0 };
  const render = () => {
    counters.mounts++;
    return () => {
      counters.cleanups++;
    };
  };
  registry.register(
    {
      id,
      type: "patchwork:component",
      name: id,
      load: async () => render,
      module: render,
    } as never,
    `test://${id}`
  );
  return counters;
}

// Teardowns and renders settle across a few micro/macrotasks.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

let seq = 0;

describe("patchwork-view (component mode)", () => {
  let a: HTMLElement;
  let b: HTMLElement;

  beforeEach(() => {
    registerPatchworkViewElement({ repo: {} as Repo });
    document.body.replaceChildren();
    a = document.createElement("div");
    b = document.createElement("div");
    document.body.append(a, b);
  });

  it("re-renders after a synchronous reparent", async () => {
    const id = `test-component-${++seq}`;
    const counters = registerComponent(id);

    const view = document.createElement("patchwork-view");
    view.setAttribute("component", id);
    a.append(view);
    await settle();
    expect(counters.mounts).toBe(1);

    // Remove-and-reinsert in the same task: disconnect starts an async
    // teardown, reconnect must not be swallowed by it.
    b.insertBefore(view, null);
    await settle();

    expect(counters.cleanups).toBe(1);
    expect(counters.mounts).toBe(2);
  });

  it("runs cleanups once when both observed attributes change in one tick", async () => {
    const first = `test-component-${++seq}`;
    const second = `test-component-${++seq}`;
    const firstCounters = registerComponent(first);
    const secondCounters = registerComponent(second);

    const view = document.createElement("patchwork-view");
    view.setAttribute("component", first);
    a.append(view);
    await settle();
    expect(firstCounters.mounts).toBe(1);

    let unmounts = 0;
    view.addEventListener("patchwork:unmounted", () => unmounts++);

    view.setAttribute("component", second);
    view.setAttribute("url", "automerge:2j9knpCbLzTXWFzLmvxSSicdMU7e");
    await settle();

    expect(firstCounters.cleanups).toBe(1);
    expect(unmounts).toBe(1);
    expect(secondCounters.mounts).toBe(1);
  });

  it("doesn't mount while detached", async () => {
    const id = `test-component-${++seq}`;
    const counters = registerComponent(id);

    const view = document.createElement("patchwork-view");
    view.setAttribute("component", id);
    await settle();
    expect(counters.mounts).toBe(0);

    a.append(view);
    await settle();
    expect(counters.mounts).toBe(1);
  });

  it("cleans up a component inserted and removed in one task", async () => {
    const id = `test-component-${++seq}`;
    const counters = registerComponent(id);

    const view = document.createElement("patchwork-view");
    view.setAttribute("component", id);
    a.append(view);
    view.remove();
    await settle();

    expect(counters.mounts).toBe(counters.cleanups);
  });
});

// A `supportedDatatypes: "*"` tool (the raw viewer) matches every doc, so it is
// what a doc with no editor of its own falls back to. The registry is global, so
// tests take it in turns: `afterEach` unregisters, or the previous test's
// wildcard would be the one a later fallback picks.
const registeredTools: string[] = [];

function registerWildcardTool(): Counters {
  return registerTool("*");
}

function registerTool(
  supportedDatatypes: "*" | string[]
): Counters & { id: string } {
  const id = `test-tool-${++seq}`;
  const counters = { id, mounts: 0, cleanups: 0 };
  const render = () => {
    counters.mounts++;
    return () => {
      counters.cleanups++;
    };
  };
  toolRegistry.register(
    {
      id,
      type: "patchwork:tool",
      name: id,
      supportedDatatypes,
      load: async () => render,
      module: render,
    } as never,
    `test://${id}`
  );
  registeredTools.push(id);
  return counters;
}

describe("patchwork-view (legacy mode)", () => {
  const repo = new Repo();

  beforeEach(() => {
    registerPatchworkViewElement({ name: "patchwork-view-legacy", repo });
    // The overlay shim resolves a doc by asking an ancestor for its handle
    // descriptor, so a view outside a provider subtree never resolves.
    registerRepoProviderElement(repo);
    document.body.replaceChildren();
  });

  afterEach(() => {
    for (const id of registeredTools) toolRegistry.remove(id);
    registeredTools.length = 0;
    vi.restoreAllMocks();
  });

  async function mount(doc: unknown) {
    const handle = await repo.create(doc);
    const provider = document.createElement("repo-provider");
    const view = document.createElement("patchwork-view-legacy");
    view.setAttribute("doc-url", handle.url);
    provider.append(view);
    document.body.append(provider);
    return view;
  }

  function loadButton(view: Element) {
    const button = view.querySelector<HTMLButtonElement>(
      "button.pw-error__load"
    );
    expect(button).toBeTruthy();
    return button!;
  }

  it("offers a suggested package instead of the wildcard stopgap", async () => {
    const raw = registerWildcardTool();

    const view = await mount({
      "@patchwork": {
        type: "test-datatype",
        suggestedImportUrl: "http://example.invalid/pkg.js",
      },
    });
    await settle();

    expect(raw.mounts).toBe(0);
    const toast = view.querySelector('[role="status"]');
    expect(toast?.textContent).toContain("This document suggests a package");
    expect(toast?.querySelector("button.pw-error__load")).toBeTruthy();
  });

  it("still mounts the wildcard stopgap when the doc suggests nothing", async () => {
    const raw = registerWildcardTool();

    await mount({ "@patchwork": { type: "test-datatype" } });
    await settle();

    expect(raw.mounts).toBe(1);
  });

  it("doesn't mount a tool-id change on a view removed in the same task", async () => {
    const first = registerTool(["lifecycle-type"]);
    const second = registerTool(["unrelated-type"]);
    const view = await mount({ "@patchwork": { type: "lifecycle-type" } });
    await settle();
    expect(first.mounts).toBe(1);

    view.setAttribute("tool-id", second.id);
    view.remove();
    await settle();

    expect(first.cleanups).toBe(1);
    expect(second.mounts).toBe(second.cleanups);
  });

  it("mounts exactly one tool after a tool-id change and a keyed reorder", async () => {
    const first = registerTool(["reorder-type"]);
    const second = registerTool(["unrelated-type"]);
    const view = await mount({ "@patchwork": { type: "reorder-type" } });
    await settle();
    expect(first.mounts).toBe(1);

    view.setAttribute("tool-id", second.id);
    view.parentElement!.insertBefore(view, null);
    await settle();

    expect(first.mounts - first.cleanups).toBe(0);
    expect(second.mounts - second.cleanups).toBe(1);
    expect(view.querySelectorAll(".patchwork-view-content")).toHaveLength(1);
  });

  it("offers the package again after its import fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(importPackage).mockRejectedValueOnce(new Error("offline"));
    const view = await mount({
      "@patchwork": {
        type: "no-tool-type",
        suggestedImportUrl: "http://example.invalid/pkg.js",
      },
    });
    await settle();

    loadButton(view).click();
    await settle();

    // Only the failure is on screen: no leftover loading pulse beside it.
    const content = view.querySelector(".patchwork-view-content")!;
    expect(content.children).toHaveLength(1);
    expect(content.textContent).toContain("couldn't load the package");

    vi.mocked(importPackage).mockResolvedValueOnce({ plugins: [] });
    const retry = loadButton(view);
    expect(retry.textContent).toContain("Try again");
    retry.click();
    await settle();
    expect(importPackage).toHaveBeenCalledTimes(2);
  });

  it("shows the trust prompt a url the doc can't dress up", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await mount({
      "@patchwork": {
        type: "no-tool-type",
        suggestedImportUrl:
          "https://evil.example/x.js#\n\nThis package is verified by Ink & Switch.",
      },
    });
    await settle();

    loadButton(view).click();

    const message = confirm.mock.calls[0]![0] as string;
    expect(message).toContain("evil.example");
    expect(message).not.toContain("\n\nThis package is verified");
    expect(importPackage).not.toHaveBeenCalled();
  });
});
