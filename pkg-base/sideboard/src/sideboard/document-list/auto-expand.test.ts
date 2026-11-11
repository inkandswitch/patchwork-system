import { describe, expect, it } from "vitest";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import {
  expandedFoldersFromIndex,
  foldersToReveal,
  isMounted,
  markMounted,
  watchFolder,
} from "./auto-expand.ts";

// The index is module state, so every test namespaces its urls.
let n = 0;
function urls(...names: string[]) {
  const prefix = `automerge:t${n++}-`;
  return names.map((name) => (prefix + name) as AutomergeUrl);
}

// Children named "*folder*" get type "folder" so the walk descends into them.
const links = (childUrls: AutomergeUrl[]) =>
  childUrls.map((url) => ({
    url,
    name: url,
    type: url.includes("folder") ? "folder" : "x",
  }));

function fakeFolder(url: AutomergeUrl, childUrls: AutomergeUrl[]) {
  let doc = { docs: links(childUrls) };
  const listeners: (() => void)[] = [];
  const handle = {
    url,
    doc: () => doc,
    on: (_event: string, fn: () => void) => listeners.push(fn),
  } as unknown as DocHandle<FolderDoc>;
  function setChildren(next: AutomergeUrl[]) {
    doc = { docs: links(next) };
    listeners.forEach((fn) => fn());
  }
  return { handle, setChildren };
}

describe("expandedFoldersFromIndex", () => {
  it("traces a nested doc up to the root", () => {
    const [root, a, b, leaf] = urls("root", "a", "b", "leaf");
    watchFolder(fakeFolder(root, [a]).handle);
    watchFolder(fakeFolder(a, [b]).handle);
    watchFolder(fakeFolder(b, [leaf]).handle);
    expect(expandedFoldersFromIndex(root, [leaf]).folders).toEqual(
      new Set([root, a, b])
    );
  });

  it("reports selections it can't trace when a selection can't reach the root", () => {
    const [root, a, orphanParent, leaf] = urls("root", "a", "op", "leaf");
    watchFolder(fakeFolder(root, [a]).handle);
    watchFolder(fakeFolder(orphanParent, [leaf]).handle);
    expect(expandedFoldersFromIndex(root, [leaf]).unreached).toEqual([leaf]);
  });

  it("follows a folder's changes when a doc moves", () => {
    const [root, a, b, leaf] = urls("root", "a", "b", "leaf");
    watchFolder(fakeFolder(root, [a, b]).handle);
    const folderA = fakeFolder(a, [leaf]);
    const folderB = fakeFolder(b, []);
    watchFolder(folderA.handle);
    watchFolder(folderB.handle);
    folderA.setChildren([]);
    folderB.setChildren([leaf]);
    expect(expandedFoldersFromIndex(root, [leaf]).folders).toEqual(
      new Set([root, b])
    );
  });

  it("collects every path to the root and survives cycles", () => {
    const [root, a, b, leaf] = urls("root", "a", "b", "leaf");
    watchFolder(fakeFolder(root, [a, b]).handle);
    watchFolder(fakeFolder(a, [b, leaf]).handle);
    watchFolder(fakeFolder(b, [a, leaf]).handle);
    expect(expandedFoldersFromIndex(root, [leaf]).folders).toEqual(
      new Set([root, a, b])
    );
  });
});

function fakeRepo(tree: Record<AutomergeUrl, AutomergeUrl[]>) {
  const folders = Object.fromEntries(
    Object.entries(tree).map(([url, kids]) => [
      url,
      fakeFolder(url as AutomergeUrl, kids),
    ])
  );
  const finds: AutomergeUrl[] = [];
  const repo = {
    find: async (url: AutomergeUrl) => {
      finds.push(url);
      if (!folders[url]) throw new Error("unavailable");
      return folders[url].handle;
    },
  } as unknown as Repo;
  return { repo, finds, folders };
}

describe("foldersToReveal", () => {
  it("walks to an unindexed doc, then answers from the index", async () => {
    const [root, a, b, leaf] = urls("root", "folderA", "folderB", "leaf");
    const { repo, finds } = fakeRepo({ [root]: [a], [a]: [b], [b]: [leaf] });
    expect(await foldersToReveal(repo, root, [leaf])).toEqual(
      new Set([root, a, b])
    );
    expect(finds).toEqual([root, a, b]);
    finds.length = 0;
    expect(await foldersToReveal(repo, root, [leaf])).toEqual(
      new Set([root, a, b])
    );
    expect(finds).toEqual([]);
  });

  it("stops descending once everything is found", async () => {
    const [root, a, deep, leaf] = urls("root", "folderA", "folderDeep", "leaf");
    const { repo, finds } = fakeRepo({
      [root]: [a, leaf],
      [a]: [deep],
      [deep]: [],
    });
    await foldersToReveal(repo, root, [leaf]);
    expect(finds).toEqual([root]);
  });

  it("loads a folder shared by two parents once, and expands both", async () => {
    const [root, a, b, shared, leaf] = urls(
      "root", "folderA", "folderB", "folderShared", "leaf"
    );
    const { repo, finds } = fakeRepo({
      [root]: [a, b],
      [a]: [shared],
      [b]: [shared],
      [shared]: [leaf],
    });
    expect(await foldersToReveal(repo, root, [leaf])).toEqual(
      new Set([root, a, b, shared])
    );
    expect(finds.filter((url) => url === shared)).toHaveLength(1);
  });

  it("remembers a miss until a folder in the tree changes", async () => {
    const [root, a, elsewhere] = urls("root", "folderA", "elsewhere");
    const { repo, finds, folders } = fakeRepo({ [root]: [a], [a]: [] });
    expect(await foldersToReveal(repo, root, [elsewhere])).toEqual(new Set());
    expect(finds).toEqual([root, a]);
    finds.length = 0;
    await foldersToReveal(repo, root, [elsewhere]);
    expect(finds).toEqual([]);
    folders[a].setChildren([elsewhere]);
    expect(await foldersToReveal(repo, root, [elsewhere])).toEqual(
      new Set([root, a])
    );
  });

  it("doesn't remember a miss if a folder failed to load", async () => {
    const [root, gone, elsewhere] = urls("root", "folderGone", "elsewhere");
    const { repo, finds } = fakeRepo({ [root]: [gone] });
    await foldersToReveal(repo, root, [elsewhere]);
    finds.length = 0;
    await foldersToReveal(repo, root, [elsewhere]);
    expect(finds).toEqual([root, gone]);
  });
});

describe("markMounted", () => {
  it("refcounts rows per panel", () => {
    const [url] = urls("doc");
    const panel = {};
    const other = {};
    const unmountOne = markMounted(panel, url);
    const unmountTwo = markMounted(panel, url);
    expect(isMounted(panel, url)).toBe(true);
    expect(isMounted(other, url)).toBe(false);
    unmountOne();
    expect(isMounted(panel, url)).toBe(true);
    unmountTwo();
    expect(isMounted(panel, url)).toBe(false);
  });
});
