/**
 * Heads on a URL pin the document they name, and nothing further.
 *
 * `resolvePath` walks from a root document to a file by following links, and those links are
 * ordinarily bare — pushwork pins them only inside artifact directories. So the content behind
 * `/{root#heads}/a/b` can change while the URL does not, which makes it unsafe to cache as if it
 * were content-addressed.
 *
 * These tests pin that property down, and check that a resolution reports whether it was pinned
 * the whole way, so a caller can tell an immutable answer from a merely current one.
 */
import { describe, expect, it } from "vitest";
import {
  Repo,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { resolvePath } from "../src/resolve.js";

type FileDoc = { "@patchwork": { type: "file" }; content: string; mimeType: string; name: string };
type FolderDoc = { "@patchwork": { type: "folder" }; title: string; docs: { name: string; type: string; url: AutomergeUrl }[] };

const repo = () => new Repo({ network: [] });

const pin = (handle: DocHandle<unknown>): AutomergeUrl =>
  stringifyAutomergeUrl({
    documentId: parseAutomergeUrl(handle.url).documentId,
    heads: handle.heads()!,
  });

/** root ──link──> child ──link──> file, with each link bare or pinned as asked. */
async function tree(r: Repo, { pinLinks }: { pinLinks: boolean }) {
  const file = await r.create2<FileDoc>({
    "@patchwork": { type: "file" },
    content: "first",
    mimeType: "text/plain",
    name: "page.txt",
  });
  const child = await r.create2<FolderDoc>({
    "@patchwork": { type: "folder" },
    title: "child",
    docs: [{ name: "page.txt", type: "txt", url: pinLinks ? pin(file) : file.url }],
  });
  const root = await r.create2<FolderDoc>({
    "@patchwork": { type: "folder" },
    title: "root",
    docs: [{ name: "child", type: "folder", url: pinLinks ? pin(child) : child.url }],
  });
  return { file, child, root };
}

describe("resolvePath and what heads actually pin", () => {
  it("content behind a pinned root changes when a bare link below it moves", async () => {
    const r = repo();
    const { file, root } = await tree(r, { pinLinks: false });

    // Pin the root, then read through it.
    const headsAtFirstRead = root.heads()!;
    const before = await resolvePath(r, root.view(headsAtFirstRead), ["child", "page.txt"]);
    expect(String(before?.content)).toBe("first");

    // Change the file. The root is untouched — rewriting a page never touches the repo root,
    // which is exactly the case this models.
    file.change((d) => {
      d.content = "second";
    });
    expect(root.heads()).toEqual(headsAtFirstRead);

    // Same root, same heads, same path — different bytes.
    const after = await resolvePath(r, root.view(headsAtFirstRead), ["child", "page.txt"]);
    expect(String(after?.content)).toBe("second");
  });

  it("says a resolution was not pinned when any link on the path was bare", async () => {
    const r = repo();
    const { root } = await tree(r, { pinLinks: false });
    const resolved = await resolvePath(r, root.view(root.heads()!), ["child", "page.txt"]);
    expect(resolved?.pinned).toBe(false);
  });

  it("says a resolution was pinned when every link carried heads", async () => {
    const r = repo();
    const { root } = await tree(r, { pinLinks: true });
    const resolved = await resolvePath(r, root.view(root.heads()!), ["child", "page.txt"]);
    expect(resolved?.pinned).toBe(true);
  });

  it("an unpinned root is never a pinned resolution, however its links are written", async () => {
    const r = repo();
    const { root } = await tree(r, { pinLinks: true });
    // Reading from the live handle rather than a view: there are no heads in play at all.
    const resolved = await resolvePath(r, root, ["child", "page.txt"]);
    expect(resolved?.pinned).toBe(false);
  });

  it("reaching a document directly is pinned only if that document was", async () => {
    const r = repo();
    const { file } = await tree(r, { pinLinks: false });
    expect((await resolvePath(r, file.view(file.heads()!), []))?.pinned).toBe(true);
    expect((await resolvePath(r, file, []))?.pinned).toBe(false);
  });
});
