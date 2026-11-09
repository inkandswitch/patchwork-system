import { describe, expect, it, vi } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";

import { loadFolderTree } from "../src/folder-tree.js";

type Link = { name: string; type: string; url: AutomergeUrl };

function folder(repo: Repo, docs: Link[] = []) {
  return repo.create({ "@patchwork": { type: "folder" }, title: "f", docs });
}

describe("loadFolderTree", () => {
  it("finds every folder under the root, and none of the files", async () => {
    const repo = new Repo();
    const deep = folder(repo);
    const file = repo.create({ "@patchwork": { type: "markdown" } });
    const inner = folder(repo, [
      { name: "deep", type: "folder", url: deep.url },
      { name: "notes", type: "markdown", url: file.url },
    ]);
    const root = folder(repo, [
      { name: "inner", type: "folder", url: inner.url },
    ]);
    const find = vi.spyOn(repo, "find");

    expect(await loadFolderTree(repo, root.url)).toBe(3);
    const found = find.mock.calls.map(([url]) => url);
    expect(found).toEqual([root.url, inner.url, deep.url]);
  });

  it("says how many it's found as it goes, and when it's done", async () => {
    const repo = new Repo();
    const inner = folder(repo);
    const root = folder(repo, [
      { name: "inner", type: "folder", url: inner.url },
    ]);
    const onProgress = vi.fn();
    await loadFolderTree(repo, root.url, { onProgress });
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      { found: 1, done: false },
      { found: 2, done: false },
      { found: 2, done: true },
    ]);
  });

  it("goes round a cycle once", async () => {
    const repo = new Repo();
    const root = folder(repo);
    const child = folder(repo, [{ name: "up", type: "folder", url: root.url }]);
    root.change((d: any) => {
      d.docs.push({ name: "child", type: "folder", url: child.url });
    });
    expect(await loadFolderTree(repo, root.url)).toBe(2);
  });

  it("skips a folder it can't find, and goes on with the rest", async () => {
    const repo = new Repo();
    const ok = folder(repo);
    const root = folder(repo, [
      {
        name: "gone",
        type: "folder",
        url: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ" as AutomergeUrl,
      },
      { name: "ok", type: "folder", url: ok.url },
    ]);
    const find = repo.find.bind(repo);
    vi.spyOn(repo, "find").mockImplementation((url: any, ...rest: any[]) =>
      url === root.url || url === ok.url
        ? find(url, ...rest)
        : Promise.reject(new Error("unavailable"))
    );
    expect(await loadFolderTree(repo, root.url)).toBe(2);
  });

  it("gives up waiting after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const repo = new Repo();
      vi.spyOn(repo, "find").mockReturnValue(new Promise(() => {}));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const done = loadFolderTree(
        repo,
        "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ" as AutomergeUrl,
        {
          timeoutMs: 3_000,
        }
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await done).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
