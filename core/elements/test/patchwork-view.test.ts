import { Repo } from "@automerge/automerge-repo";
import {
  importPackage,
  importPackageWithJson,
  packages,
  readPackageJson,
  sourceOf,
  type AddedBy,
  type LivePlugin,
} from "@inkandswitch/patchwork-filesystem";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The suggested-import tests decide what a package import does; nothing here
// should reach the network.
vi.mock("@inkandswitch/patchwork-filesystem", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPackage: vi.fn(async () => {
    throw new Error("importPackage not stubbed for this test");
  }),
  importPackageWithJson: vi.fn(async () => {
    throw new Error("importPackageWithJson not stubbed for this test");
  }),
  readPackageJson: vi.fn(async () => undefined),
}));

import { registerPatchworkViewElement } from "../src/patchwork-view.js";

// The database is global, so each test takes out what it added: otherwise a
// previous test's wildcard tool would be the one a later default picks.
const added: string[] = [];

afterEach(() => {
  for (const key of added) packages.remove(key);
  added.length = 0;
});

function addPackage(
  key: string,
  plugins: LivePlugin[],
  options: { addedBy?: AddedBy; version?: string; importUrl?: string } = {}
) {
  added.push(key);
  return packages.add({
    key,
    version: options.version ?? "1",
    importUrl: options.importUrl ?? key,
    plugins,
    addedBy: options.addedBy ?? { by: "package-list", entry: key },
  });
}

type Counters = { mounts: number; cleanups: number };

function registerComponent(id: string): Counters {
  const counters: Counters = { mounts: 0, cleanups: 0 };
  const render = () => {
    counters.mounts++;
    return () => {
      counters.cleanups++;
    };
  };
  addPackage(`test://${id}`, [
    {
      id,
      type: "patchwork:component",
      name: id,
      load: async () => render,
      module: render,
    },
  ]);
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

  it("a component renders from the database", async () => {
    let mounts = 0;
    addPackage("test://db-component", [
      {
        id: "db-component",
        type: "patchwork:component",
        name: "db-component",
        load: async () => () => {
          mounts++;
          return () => {};
        },
      },
    ]);

    const view = document.createElement("patchwork-view");
    view.setAttribute("component", "db-component");
    a.append(view);
    await vi.waitFor(() => expect(mounts).toBe(1));
  });
});

// A `supportedDatatypes: "*"` tool (the raw viewer) matches every doc, so it is
// what a doc with no editor of its own falls back to.
function registerWildcardTool() {
  return registerTool("*");
}

function registerTool(
  supportedDatatypes: "*" | string[],
  extra: Record<string, unknown> = {}
): Counters & { id: string } {
  const id = `test-tool-${++seq}`;
  const counters = { id, mounts: 0, cleanups: 0 };
  const render = () => {
    counters.mounts++;
    return () => {
      counters.cleanups++;
    };
  };
  addPackage(`test://${id}`, [
    {
      id,
      type: "patchwork:tool",
      name: id,
      supportedDatatypes,
      load: async () => render,
      module: render,
      ...extra,
    },
  ]);
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

  it("a view mounts a tool from the database", async () => {
    let mounts = 0;
    addPackage("test://db-tool", [
      {
        id: "db-tool",
        type: "patchwork:tool",
        name: "db-tool",
        supportedDatatypes: ["db-type"],
        load: async () => () => {
          mounts++;
          return () => {};
        },
      },
    ]);

    mount({ "@patchwork": { type: "db-type" } });
    await vi.waitFor(() => expect(mounts).toBe(1));
  });

  it("a new version of its package remounts in place", async () => {
    const mounts: string[] = [];
    const cleanups: string[] = [];
    const addVersion = (version: string) =>
      addPackage(
        "test://versioned",
        [
          {
            id: "versioned",
            type: "patchwork:tool",
            name: "versioned",
            supportedDatatypes: ["versioned-type"],
            load: async () => () => {
              mounts.push(version);
              return () => {
                cleanups.push(version);
              };
            },
          },
        ],
        { version, importUrl: `test://versioned#${version}` }
      );

    addVersion("v1");
    const view = mount({ "@patchwork": { type: "versioned-type" } });
    await vi.waitFor(() => expect(mounts).toEqual(["v1"]));
    const content = view.querySelector(".patchwork-view-content");

    addVersion("v2");
    await vi.waitFor(() => expect(mounts).toEqual(["v1", "v2"]));
    expect(cleanups).toEqual(["v1"]);
    expect(view.querySelector(".patchwork-view-content")).toBe(content);
  });

  it("the default tool ignores packages only js added", async () => {
    let mounts = 0;
    addPackage(
      "test://js-only",
      [
        {
          id: "js-only",
          type: "patchwork:tool",
          name: "js-only",
          supportedDatatypes: ["js-type"],
          module: () => {
            mounts++;
            return () => {};
          },
        },
      ],
      { addedBy: { by: "js", url: "test://js-only", stack: "" } }
    );

    const view = mount({ "@patchwork": { type: "js-type" } });
    await settle();
    expect(mounts).toBe(0);
    expect(card(view, "no-tool")).toBeTruthy();

    // asked for by id, it opens
    view.setAttribute("tool-id", "js-only");
    await vi.waitFor(() => expect(mounts).toBe(1));
  });

  it("same tool id in two packages: the one added last mounts", async () => {
    const mounted: string[] = [];
    for (const key of ["test://first-dup", "test://last-dup"]) {
      addPackage(key, [
        {
          id: "dup",
          type: "patchwork:tool",
          name: "dup",
          supportedDatatypes: ["dup-type"],
          module: () => {
            mounted.push(key);
            return () => {};
          },
        },
      ]);
    }

    // as the default tool, and by id
    mount({ "@patchwork": { type: "dup-type" } });
    mount({ "@patchwork": { type: "dup-type" } }).setAttribute("tool-id", "dup");
    await vi.waitFor(() => expect(mounted).toHaveLength(2));
    expect(mounted).toEqual(["test://last-dup", "test://last-dup"]);
  });

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
    addPackage(`test://${id}`, [
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
      },
    ]);
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

  it("reloads the page when trying a tool again fails again", async () => {
    const id = `failing-tool-${++seq}`;
    addPackage(`test://${id}`, [
      {
        id,
        type: "patchwork:tool",
        name: "Failing",
        supportedDatatypes: ["failing-again-type"],
        load: async () => {
          throw new Error("the file didn't arrive");
        },
      },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});

    const view = mount({ "@patchwork": { type: "failing-again-type" } });
    await vi.waitFor(() => expect(card(view, "tool-failed")).toBeTruthy());
    // the first failure only puts the card up
    expect(reload).not.toHaveBeenCalled();

    buttonLabelled(view, "try again").click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("offers other tools when the asked-for one doesn't load", async () => {
    const id = `failing-tool-${++seq}`;
    addPackage(`test://${id}`, [
      {
        id,
        type: "patchwork:tool",
        name: "Failing",
        supportedDatatypes: ["open-with-type"],
        load: async () => {
          throw new Error("the file didn't arrive");
        },
      },
    ]);
    const other = registerTool(["open-with-type"]);
    const elsewhere = registerTool(["unrelated-type"]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const view = mount({ "@patchwork": { type: "open-with-type" } });
    // pinned, so the pick has to win over tool-id
    view.setAttribute("tool-id", id);
    await vi.waitFor(() => expect(card(view, "tool-failed")).toBeTruthy());

    buttonLabelled(view, "open with…").click();
    const offered = [...view.querySelectorAll(".pw-card__tool")].map(
      (b) => b.textContent
    );
    expect(offered).toContain(other.id);
    expect(offered).not.toContain(id);
    expect(offered).not.toContain(elsewhere.id);

    // a tool that isn't offered can still be asked for by id
    const search = view.querySelector<HTMLInputElement>(".pw-card__search")!;
    search.value = elsewhere.id;
    search.dispatchEvent(new Event("input"));
    expect(view.querySelector(".pw-card__tool")?.textContent).toBe(
      `use tool id ${elsewhere.id}`
    );
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await vi.waitFor(() => expect(elsewhere.mounts).toBe(1));
    expect(card(view, "tool-failed")).toBeNull();
    expect(other.mounts).toBe(0);
  });

  it("offers the other frames when an account's frame tool isn't there", async () => {
    const frame = registerTool(["account"], { tags: ["frame-tool"] });
    const sidebar = registerTool(["account"]);
    const missing = `missing-frame-${++seq}`;

    const view = mount({ "@patchwork": { type: "account" }, frameToolId: missing });
    view.setAttribute("tool-id", missing);
    await vi.waitFor(() => expect(card(view, "no-tool")).toBeTruthy());

    buttonLabelled(view, "open with…").click();
    const offered = [...view.querySelectorAll(".pw-card__tool")].map(
      (b) => b.textContent
    );
    expect(offered).toEqual([frame.id]);
    expect(offered).not.toContain(sidebar.id);

    (view.querySelector(".pw-card__tool") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(frame.mounts).toBe(1));
    expect(card(view, "no-tool")).toBeNull();
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

  describe("package-url", () => {
    type Mounts = { url: string; toolId: string; cleanedUp: boolean }[];
    let mounts: Mounts;

    // Each import of a package gives tools that note which url they came
    // from, so a test can see which version is mounted.
    function servePackage(toolIds: Record<string, string[] | "*">) {
      vi.mocked(importPackage).mockImplementation(async (url: string) => ({
        plugins: Object.entries(toolIds).map(([id, supportedDatatypes]) => ({
          id,
          type: "patchwork:tool",
          name: id,
          supportedDatatypes,
          load: async () => (_handle: unknown, element: HTMLElement) => {
            const mount = { url, toolId: id, cleanedUp: false };
            mounts.push(mount);
            element.textContent = `${id} from ${url}`;
            return () => {
              mount.cleanedUp = true;
            };
          },
        })),
      }));
    }

    const live = () => mounts.filter((m) => !m.cleanedUp);

    beforeEach(() => {
      mounts = [];
    });

    afterEach(() => {
      vi.mocked(importPackage).mockReset();
      vi.mocked(readPackageJson).mockReset();
      vi.mocked(readPackageJson).mockResolvedValue(undefined);
    });

    function mountWith(doc: unknown, attrs: Record<string, string>) {
      const handle = repo.create(doc);
      const provider = document.createElement("repo-provider");
      const view = document.createElement("patchwork-view-legacy");
      view.setAttribute("doc-url", handle.url);
      for (const [name, value] of Object.entries(attrs)) {
        view.setAttribute(name, value);
      }
      provider.append(view);
      document.body.append(provider);
      return view;
    }

    it("shows the doc with the package's tool for tool-id, not the registry's", async () => {
      const registered = registerTool(["pkg-type"]);
      servePackage({ [registered.id]: ["pkg-type"], other: ["pkg-type"] });
      const mounted = vi.fn();
      document.addEventListener("patchwork:mounted", mounted);
      const view = mountWith(
        { "@patchwork": { type: "pkg-type" } },
        {
          "tool-id": registered.id,
          "package-url": "http://example.invalid/tool-id-pkg/",
        }
      );
      await vi.waitFor(() => expect(live()).toHaveLength(1));
      document.removeEventListener("patchwork:mounted", mounted);

      expect(registered.mounts).toBe(0);
      expect(live()[0].toolId).toBe(registered.id);
      expect(mounted.mock.calls.at(-1)![0].detail).toEqual({
        url: view.getAttribute("doc-url"),
        toolId: registered.id,
      });

      view.remove();
      await settle();
      expect(live()).toHaveLength(0);
    });

    it("picks the package's tool for the doc's type without a tool-id", async () => {
      servePackage({ anything: "*", made: ["made-type"], else: ["else-type"] });
      mountWith(
        { "@patchwork": { type: "made-type" } },
        { "package-url": "http://example.invalid/by-type-pkg/" }
      );
      await vi.waitFor(() => expect(live()).toHaveLength(1));
      expect(live()[0].toolId).toBe("made");
    });

    it("names the type when the package has no tool for it", async () => {
      servePackage({ other: ["other-type"] });
      const view = mountWith(
        { "@patchwork": { type: "lonely-type" } },
        { "package-url": "http://example.invalid/no-type-pkg/" }
      );
      await vi.waitFor(() =>
        expect(card(view, "tool-failed")?.textContent).toContain(
          "the package doesn't have a tool for lonely-type"
        )
      );
    });

    it("says so when the package has no such tool", async () => {
      servePackage({ other: ["pkg-type"] });
      const view = mountWith(
        { "@patchwork": { type: "pkg-type" } },
        {
          "tool-id": "missing",
          "package-url": "http://example.invalid/missing-pkg/",
        }
      );
      await vi.waitFor(() =>
        expect(card(view, "tool-failed")?.textContent).toContain(
          "the package doesn't have missing"
        )
      );
      expect(card(view, "tool-failed")?.textContent).not.toContain(
        "can't load"
      );
    });

    it("blames the package when it doesn't import", async () => {
      vi.mocked(importPackage).mockRejectedValue(new Error("not json"));
      const view = mountWith(
        { "@patchwork": { type: "pkg-type" } },
        {
          "tool-id": "broken",
          "package-url": "http://example.invalid/broken-pkg/",
        }
      );
      await vi.waitFor(() => expect(card(view, "tool-failed")).toBeTruthy());
      const text = card(view, "tool-failed")?.textContent;
      expect(text).toContain("can't load the package containing broken");
      expect(text).toContain("the package containing the tool");
      expect(text).toContain("not json");
    });

    it.each(["missing", "broken"])(
      "opens a registered tool instead when the package is %s",
      async (failure) => {
        const other = registerTool(["pkg-type"]);
        if (failure === "missing") servePackage({ other: ["other-type"] });
        else vi.mocked(importPackage).mockRejectedValue(new Error("not json"));
        const view = mountWith(
          { "@patchwork": { type: "pkg-type" } },
          {
            "tool-id": "asked-for",
            "package-url": "http://example.invalid/package/",
          }
        );
        await vi.waitFor(() => expect(card(view, "tool-failed")).toBeTruthy());
        buttonLabelled(view, "open with…").click();
        (view.querySelector(".pw-card__tool") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(other.mounts).toBe(1));
        expect(card(view, "tool-failed")).toBeNull();
        expect(live()).toHaveLength(0);
      }
    );

    // The package.json the database is given for a package at `url`.
    function servePackageJson() {
      vi.mocked(readPackageJson).mockImplementation(async (url: string) => ({
        importUrl: url,
        base: url,
        packageJson: { name: "served" },
        version: "v1",
      }));
    }

    it("package-url adds the package when there's no entry", async () => {
      servePackage({ added: ["pkg-type"] });
      servePackageJson();
      const url = "http://example.invalid/added-pkg/";
      mountWith(
        { "@patchwork": { type: "pkg-type" } },
        { "tool-id": "added", "package-url": url }
      );
      await vi.waitFor(() => expect(packages.get(sourceOf(url)!)).toBeTruthy());

      const entry = packages.get(sourceOf(url)!)!;
      expect(entry.addedBy).toEqual([{ by: "package-url" }]);
      expect(entry.version).toBe("v1");
      expect(entry.packageJson).toEqual({ name: "served" });
      expect(entry.plugins.map((p) => [p.id, p.load])).toEqual([
        ["added", undefined],
      ]);
      packages.remove(sourceOf(url)!);
    });

    it("package-url leaves an existing one alone", async () => {
      servePackage({ listed: ["pkg-type"] });
      servePackageJson();
      const url = "http://example.invalid/listed-pkg/";
      const listed = packages.add({
        key: sourceOf(url)!,
        version: "v0",
        importUrl: url,
        plugins: [],
        addedBy: { by: "package-list", entry: url },
      });
      mountWith(
        { "@patchwork": { type: "pkg-type" } },
        { "tool-id": "listed", "package-url": url }
      );
      await vi.waitFor(() => expect(live()).toHaveLength(1));
      await settle();

      expect(packages.get(sourceOf(url)!)).toBe(listed);
      expect(listed.addedBy).toEqual([
        { by: "package-list", entry: url },
      ]);
      packages.remove(sourceOf(url)!);
    });

    it("follows an automerge package without heads to its new heads", async () => {
      servePackage({ followed: ["pkg-type"] });
      const pkg = repo.create<{ version: number }>({ version: 1 });
      mountWith(
        { "@patchwork": { type: "pkg-type" } },
        { "tool-id": "followed", "package-url": pkg.url }
      );
      await vi.waitFor(() => expect(live()).toHaveLength(1));
      const first = live()[0].url;
      // imported pinned to the heads it had
      expect(first).toBe(pkg.view(pkg.heads()).url);

      pkg.change((d) => {
        d.version = 2;
      });
      await vi.waitFor(() =>
        expect(live().map((m) => m.url)).toEqual([pkg.view(pkg.heads()).url])
      );
      expect(mounts).toHaveLength(2);
      expect(mounts[0].cleanedUp).toBe(true);
    });

    it("stays on the version an automerge package's heads name", async () => {
      servePackage({ pinned: ["pkg-type"] });
      const pkg = repo.create<{ version: number }>({ version: 1 });
      const pinned = pkg.view(pkg.heads()).url;
      mountWith(
        { "@patchwork": { type: "pkg-type" } },
        { "tool-id": "pinned", "package-url": pinned }
      );
      await vi.waitFor(() => expect(live()).toHaveLength(1));

      pkg.change((d) => {
        d.version = 2;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mounts).toHaveLength(1);
      expect(live()[0].url).toBe(pinned);
    });
  });

  it("adds a confirmed suggestion with a package.json by suggested", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const url = "http://example.invalid/suggested-pkg/";
    vi.mocked(importPackageWithJson).mockResolvedValueOnce({
      plugins: [{ type: "patchwork:tool", id: "suggested-tool", name: "s" }],
      package: {
        importUrl: url,
        base: url,
        packageJson: { name: "suggested" },
        version: "v1",
      },
    });
    const view = mount({
      "@patchwork": { type: "no-tool-type", suggestedImportUrl: url },
    });
    await settle();

    loadButton(view).click();
    await vi.waitFor(() => expect(packages.get(sourceOf(url)!)).toBeTruthy());

    expect(packages.get(sourceOf(url)!)!.addedBy).toEqual([
      { by: "suggested" },
    ]);
    packages.remove(sourceOf(url)!);
  });

  it("offers the package again after its import fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(importPackageWithJson).mockRejectedValueOnce(new Error("offline"));
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
    vi.mocked(importPackageWithJson).mockResolvedValueOnce({ plugins: [] });
    const retry = loadButton(view);
    expect(retry.textContent).toBe("try again");
    retry.click();
    await settle();
    expect(importPackageWithJson).toHaveBeenCalledTimes(2);
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
    expect(importPackageWithJson).not.toHaveBeenCalled();
  });
});
