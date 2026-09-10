import { Repo } from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});

// A `supportedDatatypes: "*"` tool (the raw viewer) matches every doc, so it is
// what a doc with no editor of its own falls back to. The registry is global, so
// tests take it in turns: `afterEach` unregisters, or the previous test's
// wildcard would be the one a later fallback picks.
const registeredTools: string[] = [];

function registerWildcardTool(): Counters {
  const id = `test-wildcard-${++seq}`;
  const counters: Counters = { mounts: 0, cleanups: 0 };
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
      supportedDatatypes: "*",
      load: async () => render,
      module: render,
    } as never,
    `test://${id}`
  );
  registeredTools.push(id);
  return counters;
}

describe("patchwork-view (legacy mode)", () => {
  const repo = new Repo({});

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
  });

  function mount(doc: unknown) {
    const handle = repo.create(doc);
    const provider = document.createElement("repo-provider");
    const view = document.createElement("patchwork-view-legacy");
    view.setAttribute("doc-url", handle.url);
    provider.append(view);
    document.body.append(provider);
    return view;
  }

  it("offers a suggested package instead of the wildcard stopgap", async () => {
    const raw = registerWildcardTool();

    const view = mount({
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

    mount({ "@patchwork": { type: "test-datatype" } });
    await settle();

    expect(raw.mounts).toBe(1);
  });
});
