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

function registerWildcardTool() {
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
  const repo = new Repo({});

  beforeEach(() => {
    registerPatchworkViewElement({ name: "patchwork-view-legacy", repo });
    // The overlay shim resolves a doc by asking an ancestor for its handle
    // descriptor, so a view outside a provider subtree never resolves.
    registerRepoProviderElement(repo);
    document.body.replaceChildren();
  });

  beforeEach(() => {
    // a suggested package's card reads its package.json
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
  });

  afterEach(() => {
    for (const id of registeredTools) toolRegistry.remove(id);
    registeredTools.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  function loadButton(view: Element) {
    const button = view.querySelector<HTMLButtonElement>("button.pw-card__load");
    expect(button).toBeTruthy();
    return button!;
  }

  const card = (view: Element, kind: string) =>
    view.querySelector<HTMLElement>(`[data-card="${kind}"]`);

  function buttonLabelled(view: Element, label: string) {
    const button = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === label
    );
    expect(button, `a "${label}" button`).toBeTruthy();
    return button!;
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
    expect(card(view, "no-tool")?.textContent).toContain("the doc suggests");
    expect(loadButton(view).textContent).toBe("load package");
  });

  it("offers the wildcard tool rather than opening the doc with it", async () => {
    const raw = registerWildcardTool();
    const noTool = vi.fn();
    document.addEventListener("patchwork:no-tool", noTool);

    const view = mount({ "@patchwork": { type: "test-datatype" } });
    await settle();
    document.removeEventListener("patchwork:no-tool", noTool);

    expect(raw.mounts).toBe(0);
    expect(card(view, "no-tool")?.textContent).toContain("test-datatype");
    expect(noTool).toHaveBeenCalledTimes(1);

    buttonLabelled(view, `open doc with ${raw.id}`).click();
    await settle();
    expect(raw.mounts).toBe(1);
    expect(card(view, "no-tool")).toBeNull();
  });

  it("leaves a card up when a render would draw it again", async () => {
    const view = mount({ "@patchwork": { type: "redraw-type" } });
    await settle();
    const first = card(view, "no-tool");
    expect(first).toBeTruthy();

    // an unrelated tool registering re-renders, but says nothing new
    registerTool(["unrelated-type"]);
    await settle();
    expect(card(view, "no-tool")).toBe(first);
  });

  it("offers a look and a type for a doc with no @patchwork metadata", async () => {
    const raw = registerWildcardTool();
    const view = mount({ hello: "world" });
    await settle();

    const missing = card(view, "missing-type");
    expect(missing?.textContent).toContain("no @patchwork metadata");
    buttonLabelled(view, `open with ${raw.id}`).click();
    await settle();
    expect(raw.mounts).toBe(1);
  });

  it("opens a doc with the tool for the type it's given", async () => {
    const tool = registerTool(["given-type"]);
    const view = mount({ hello: "world" });
    await settle();

    const form = view.querySelector<HTMLFormElement>("form.pw-card__set-type")!;
    expect(form.hidden).toBe(true);
    buttonLabelled(view, "set type").click();
    expect(form.hidden).toBe(false);
    // what's registered is suggested
    const options = [...view.querySelectorAll("datalist option")].map(
      (o) => (o as HTMLOptionElement).value
    );
    expect(options).toContain("given-type");

    form.querySelector("input")!.value = "  given-type ";
    form.requestSubmit();
    await settle();

    expect(tool.mounts).toBe(1);
    const handle = await repo.find<{ "@patchwork": { type: string } }>(
      view.getAttribute("doc-url") as never
    );
    expect(handle.doc()["@patchwork"].type).toBe("given-type");
  });

  it("keeps the rest of @patchwork when it gives a doc a type", async () => {
    const view = mount({ "@patchwork": { copyOf: "automerge:x" } });
    await settle();
    expect(card(view, "missing-type")?.textContent).toContain(
      "doesn't say what type it is"
    );

    const form = view.querySelector<HTMLFormElement>("form.pw-card__set-type")!;
    form.querySelector("input")!.value = "kept-type";
    form.requestSubmit();
    await settle();

    const handle = await repo.find<{
      "@patchwork": { type: string; copyOf: string };
    }>(view.getAttribute("doc-url") as never);
    expect(handle.doc()["@patchwork"]).toEqual({
      type: "kept-type",
      copyOf: "automerge:x",
    });
    // no tool for it: now it says so in those words
    expect(card(view, "no-tool")?.textContent).toContain("kept-type");
  });

  it("says a link that can't name a doc is broken, and doesn't retry it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = document.createElement("repo-provider");
    const view = document.createElement("patchwork-view-legacy");
    view.setAttribute("doc-url", "automerge:not-a-doc-id");
    provider.append(view);
    document.body.append(provider);
    await settle();

    expect(card(view, "invalid-url")?.textContent).toContain(
      "automerge:not-a-doc-id"
    );
    expect(card(view, "unavailable")).toBeNull();
  });

  it("says when a tool's code doesn't load, and tries again", async () => {
    const id = `failing-tool-${++seq}`;
    let fail = true;
    const render = () => () => {};
    let mounts = 0;
    toolRegistry.register(
      {
        id,
        type: "patchwork:tool",
        name: "Failing",
        supportedDatatypes: ["failing-type"],
        load: async () => {
          if (fail) throw new Error("the file didn't arrive");
          return () => {
            mounts++;
            return render();
          };
        },
      } as never,
      `test://${id}`
    );
    registeredTools.push(id);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const view = mount({ "@patchwork": { type: "failing-type" } });
    await vi.waitFor(() => expect(card(view, "tool-failed")).toBeTruthy());
    expect(card(view, "tool-failed")?.textContent).toContain(
      "the file didn't arrive"
    );

    fail = false;
    buttonLabelled(view, "try again").click();
    await vi.waitFor(() => expect(mounts).toBe(1));
    expect(card(view, "tool-failed")).toBeNull();
  });

  it("doesn't mount a tool-id change on a view removed in the same task", async () => {
    const first = registerTool(["lifecycle-type"]);
    const second = registerTool(["unrelated-type"]);
    const view = mount({ "@patchwork": { type: "lifecycle-type" } });
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
    const view = mount({ "@patchwork": { type: "reorder-type" } });
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
    const view = mount({
      "@patchwork": {
        type: "no-tool-type",
        suggestedImportUrl: "http://example.invalid/pkg.js",
      },
    });
    await settle();

    loadButton(view).click();
    await settle();

    // Only the card is on screen, saying why.
    const content = view.querySelector(".patchwork-view-content")!;
    expect(content.children).toHaveLength(1);
    expect(content.textContent).toContain("couldn't load it: offline");

    // A package that loads but brings no tool for it says so, rather than
    // sit on "loading…".
    vi.mocked(importPackage).mockResolvedValueOnce({ plugins: [] });
    const retry = loadButton(view);
    expect(retry.textContent).toBe("try again");
    retry.click();
    await settle();
    expect(importPackage).toHaveBeenCalledTimes(2);
    expect(content.textContent).toContain(
      "it doesn't have a tool for no-tool-type"
    );
    expect(loadButton(view).disabled).toBe(false);
  });

  it("shows the trust prompt a url the doc can't dress up", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = mount({
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
