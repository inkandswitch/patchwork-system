import {
  Repo,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OverlayRepo,
  accept,
  createPatch,
  providePatchLayers,
  registerRepoProviderElement,
  type DocHandleDescriptor,
  type PatchDoc,
  type SubscribeEvent,
} from "../src/index.js";

type Clock = { theme: { accent: string; font: string }; title: string };
type Folder = {
  title: string;
  docs: { name: string; type: string; url: AutomergeUrl; off?: boolean }[];
};

let repo: Repo;
let scratch: Repo;
let clock: DocHandle<Clock>;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  repo = new Repo();
  scratch = new Repo();
  registerRepoProviderElement(repo);
  clock = repo.create<Clock>({
    theme: { accent: "lemon", font: "chicago" },
    title: "clock",
  });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.replaceChildren();
});

function folderOf(...patches: DocHandle<PatchDoc>[]) {
  return repo.create<Folder>({
    title: "skins",
    docs: patches.map((p, i) => ({
      name: `skin ${i}`,
      type: "patch",
      url: p.url,
    })),
  });
}

// <repo-provider> > ...providers > consumer, each provider a plain element
// laying one folder.
function mount(...folders: DocHandle<Folder>[]) {
  let parent: HTMLElement = document.createElement("repo-provider");
  document.body.append(parent);
  for (const folder of folders) {
    const el = document.createElement("div");
    parent.append(el);
    teardowns.push(providePatchLayers(el, { repo, folder: folder.url }));
    parent = el;
  }
  const consumer = document.createElement("div");
  parent.append(consumer);
  const overlay = new OverlayRepo(repo, consumer, { scratchRepo: scratch });
  teardowns.push(() => overlay.dispose());
  return overlay;
}

describe("providePatchLayers", () => {
  it("lays a folder's patches over documents resolved beneath it", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const handle = await mount(folderOf(skin)).find<Clock>(clock.url);
    expect(handle.url).toBe(clock.url);
    expect(handle.doc().theme.accent).toBe("cherry");

    handle.change((d) => {
      d.title = "cat clock";
    });
    expect(clock.doc().title).toBe("cat clock");
    expect(clock.doc().theme.accent).toBe("lemon");
  });

  it("passes documents no patch is on straight through", async () => {
    const other = repo.create({ n: 1 });
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const handle = await mount(folderOf(skin)).find<{ n: number }>(other.url);
    handle.change((d) => {
      d.n = 2;
    });
    expect(other.doc().n).toBe(2);
    expect(handle.doc().n).toBe(2);
  });

  it("re-lays live when a patch is added to or taken out of the folder", async () => {
    const folder = folderOf();
    const handle = await mount(folder).find<Clock>(clock.url);
    expect(handle.doc().theme.accent).toBe("lemon");

    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const replaced = vi.fn();
    handle.on("change", (p: { scopeReplaced?: boolean }) => {
      if (p.scopeReplaced) replaced();
    });
    folder.change((d) => {
      d.docs.push({ name: "skin", type: "patch", url: skin.url });
    });
    await vi.waitFor(() => expect(handle.doc().theme.accent).toBe("cherry"));
    expect(replaced).toHaveBeenCalled();

    folder.change((d) => {
      d.docs.splice(0, 1);
    });
    await vi.waitFor(() => expect(handle.doc().theme.accent).toBe("lemon"));
  });

  it("skips links switched off, and lays them again when switched on", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const folder = folderOf(skin);
    const handle = await mount(folder).find<Clock>(clock.url);
    expect(handle.doc().theme.accent).toBe("cherry");

    folder.change((d) => {
      d.docs[0].off = true;
    });
    await vi.waitFor(() => expect(handle.doc().theme.accent).toBe("lemon"));

    folder.change((d) => {
      delete d.docs[0].off;
    });
    await vi.waitFor(() => expect(handle.doc().theme.accent).toBe("cherry"));
  });

  it("stacks: the nearer provider's patches go in front", async () => {
    const far = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
      { path: ["theme", "font"], value: "monaco" },
    ]);
    const near = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "plum" },
    ]);
    const handle = await mount(folderOf(far), folderOf(near)).find<Clock>(
      clock.url
    );
    expect(handle.doc().theme).toEqual({ accent: "plum", font: "monaco" });

    handle.change((d) => {
      d.theme.font = "geneva";
    });
    expect(far.doc().patches[1].value).toBe("geneva");
    expect(clock.doc().theme.font).toBe("chicago");
  });

  it("keeps sub-handle urls in the presented document", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const overlay = mount(folderOf(skin));
    const theme = await overlay.find<Clock["theme"]>(
      `${clock.url}/theme` as AutomergeUrl
    );
    expect(theme.url).toBe(`${clock.url}/theme`);
    expect(theme.doc()).toEqual({ accent: "cherry", font: "chicago" });
  });

  it("shares one layered doc between overlays laying the same patches", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const folder = folderOf(skin);
    const a = await mount(folder).find<Clock>(clock.url);
    const b = await mount(folder).find<Clock>(clock.url);
    a.change((d) => {
      d.theme.accent = "plum";
    });
    expect(b.doc().theme.accent).toBe("plum");
    expect(Object.keys(scratch.handles)).toHaveLength(1);
  });

  it("waits for a folder given as a promise", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    let give!: (url: AutomergeUrl) => void;
    const folder = new Promise<AutomergeUrl>((resolve) => (give = resolve));
    const root = document.createElement("repo-provider");
    const el = document.createElement("div");
    const consumer = document.createElement("div");
    document.body.append(root);
    root.append(el);
    el.append(consumer);
    teardowns.push(providePatchLayers(el, { repo, folder }));
    const overlay = new OverlayRepo(repo, consumer, { scratchRepo: scratch });
    teardowns.push(() => overlay.dispose());

    const found = overlay.find<Clock>(clock.url);
    give(folderOf(skin).url);
    expect((await found).doc().theme.accent).toBe("cherry");
  });

  it("finds patch docs unremapped, past any parent view", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const decoy = repo.clone(skin);
    decoy.change((d) => {
      d.patches[0].value = "decoy";
    });
    // A remapper above everything that would swap the patch doc for a copy,
    // as a draft does to every document it sees.
    const root = document.createElement("repo-provider");
    const remapper = document.createElement("div");
    remapper.addEventListener("patchwork:subscribe", (event: SubscribeEvent) => {
      if (event.detail.selector.type !== "repo:handle-descriptor") return;
      const url = event.detail.selector.url as AutomergeUrl;
      accept<DocHandleDescriptor>(event, (respond) =>
        respond(url === skin.url ? { url, cloneUrl: decoy.url } : { url })
      );
    });
    const parentEl = document.createElement("div");
    const layer = document.createElement("div");
    const child = document.createElement("div");
    document.body.append(root);
    root.append(remapper);
    remapper.append(parentEl);
    parentEl.append(layer);
    layer.append(child);
    teardowns.push(
      providePatchLayers(layer, { repo, folder: folderOf(skin).url })
    );
    const parent = new OverlayRepo(repo, parentEl, { scratchRepo: scratch });
    const nested = new OverlayRepo(parent as unknown as Repo, child, {
      scratchRepo: scratch,
    });
    teardowns.push(() => nested.dispose(), () => parent.dispose());

    const handle = await nested.find<Clock>(clock.url);
    expect(handle.doc().theme.accent).toBe("cherry");
  });

  it("lays patches over what a nested view's parent shows", async () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const folder = folderOf(skin);
    const fork = repo.clone(clock);
    fork.change((d) => {
      d.title = "forked";
    });

    // <repo-provider> > remapper (clock → fork) > parent view > patches > child
    const root = document.createElement("repo-provider");
    const remapper = document.createElement("div");
    remapper.addEventListener("patchwork:subscribe", (event: SubscribeEvent) => {
      if (event.detail.selector.type !== "repo:handle-descriptor") return;
      const url = event.detail.selector.url as AutomergeUrl;
      accept<DocHandleDescriptor>(event, (respond) =>
        respond(url === clock.url ? { url, cloneUrl: fork.url } : { url })
      );
    });
    const parentEl = document.createElement("div");
    const layer = document.createElement("div");
    const child = document.createElement("div");
    document.body.append(root);
    root.append(remapper);
    remapper.append(parentEl);
    parentEl.append(layer);
    layer.append(child);
    teardowns.push(providePatchLayers(layer, { repo, folder: folder.url }));
    const parent = new OverlayRepo(repo, parentEl, { scratchRepo: scratch });
    const nested = new OverlayRepo(parent as unknown as Repo, child, {
      scratchRepo: scratch,
    });
    teardowns.push(() => nested.dispose(), () => parent.dispose());

    // A top-level view laying the same patches over the same url, first.
    const plain = await mount(folder).find<Clock>(clock.url);
    const inside = await nested.find<Clock>(clock.url);
    expect(plain.doc()).toMatchObject({
      title: "clock",
      theme: { accent: "cherry" },
    });
    expect(inside.doc()).toMatchObject({
      title: "forked",
      theme: { accent: "cherry" },
    });

    inside.change((d) => {
      d.title = "forked again";
    });
    expect(fork.doc().title).toBe("forked again");
    expect(clock.doc().title).toBe("clock");
  });
});
