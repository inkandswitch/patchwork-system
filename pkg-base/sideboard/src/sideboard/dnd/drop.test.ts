import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";
import type {
  FolderDoc,
  UnixFileEntry,
} from "@inkandswitch/patchwork-filesystem";
import { endSpot, rowSpot } from "./dnd.ts";
import { DropError, executeDrop } from "./operations.ts";
import { handleFilesDrop } from "../document-list/file-drop.ts";

// Just enough of a repo: real automerge docs (so deleteAt and splice behave as
// they do in the app), kept in a map by made-up url.
let n = 0;
const docs = new Map<AutomergeUrl, DocHandle<any>>();
function handleFor<T>(initial: T): DocHandle<T> {
  const url = `automerge:drop${n++}` as AutomergeUrl;
  let doc = A.from(initial as any) as A.Doc<T>;
  const handle = {
    url,
    doc: () => doc,
    change: (fn: (d: T) => void) => {
      doc = A.change(doc, fn as any);
    },
  } as unknown as DocHandle<T>;
  docs.set(url, handle);
  return handle;
}
const repo = {
  create: <T>(initial: T) => handleFor(initial),
  create2: async <T>(initial: T) => handleFor(initial),
  find: async (url: AutomergeUrl) => {
    const handle = docs.get(url);
    if (!handle) throw new Error("no such doc");
    return handle;
  },
} as unknown as Repo;

function folder(...names: string[]) {
  return repo.create<FolderDoc>({
    title: "f",
    docs: names.map((name) => ({
      name,
      type: "x",
      url: repo.create({ name }).url,
    })),
  });
}

const names = (handle: { doc(): FolderDoc | undefined }) =>
  handle.doc()!.docs.map((doc) => doc.name);

const row = (parentUrl: AutomergeUrl, index: number) => ({
  id: `${parentUrl}/${index}`,
  url: "automerge:unused" as AutomergeUrl,
  parentUrl,
  index,
});

const files = (...names: string[]) => names.map((name) => new File([name], name));

describe("rowSpot / endSpot: the one answer for where a drop lands", () => {
  it("above a row is its index, below is the next one, both in its parent", () => {
    const parent = "automerge:parent" as AutomergeUrl;
    expect(rowSpot(row(parent, 3), "above")).toMatchObject({ folderUrl: parent, index: 3 });
    expect(rowSpot(row(parent, 3), "below")).toMatchObject({ folderUrl: parent, index: 4 });
  });

  it("inside a folder row is the top of that folder", () => {
    const folderUrl = "automerge:folder" as AutomergeUrl;
    const spot = rowSpot(
      { id: folderUrl, url: folderUrl, parentUrl: "automerge:p" as AutomergeUrl, index: 2 },
      "inside"
    );
    expect(spot).toEqual({ id: folderUrl, position: "inside", folderUrl, index: 0 });
  });

  it("the end of a list is its length", () => {
    const url = "automerge:root" as AutomergeUrl;
    expect(endSpot(url, 5)).toEqual({ id: url, position: "end", folderUrl: url, index: 5 });
  });
});

describe("handleFilesDrop", () => {
  it("puts several files at the spot, in the order they were dropped", async () => {
    const f = folder("a", "b", "c");
    const spot = rowSpot(row(f.url, 0), "below");
    const { landed, failed } = await handleFilesDrop(files("1", "2", "3"), f, repo, spot.index);
    expect(names(f)).toEqual(["a", "1", "2", "3", "b", "c"]);
    expect(failed).toEqual([]);
    expect(landed.map((l) => l.index)).toEqual([1, 2, 3]);
    expect(landed.map((l) => l.url)).toEqual(f.doc()!.docs.slice(1, 4).map((d) => d.url));
  });

  it("above a row goes before it", async () => {
    const f = folder("a", "b");
    await handleFilesDrop(files("1", "2"), f, repo, rowSpot(row(f.url, 1), "above").index);
    expect(names(f)).toEqual(["a", "1", "2", "b"]);
  });

  it("the end of the list appends, rather than going to the top", async () => {
    const f = folder("a", "b");
    await handleFilesDrop(files("1", "2"), f, repo, endSpot(f.url, 2).index);
    expect(names(f)).toEqual(["a", "b", "1", "2"]);
  });

  it("inside a folder goes at its top", async () => {
    const f = folder("a", "b");
    const spot = rowSpot({ ...row(f.url, 0), id: f.url, url: f.url }, "inside");
    await handleFilesDrop(files("1", "2"), f, repo, spot.index);
    expect(names(f)).toEqual(["1", "2", "a", "b"]);
  });

  it("names a file it couldn't read and still adds the rest", async () => {
    const f = folder("a");
    const broken = new File(["x"], "broken");
    broken.arrayBuffer = () => Promise.reject(new Error("nope"));
    const { landed, failed } = await handleFilesDrop(
      [new File(["1"], "1"), broken, new File(["2"], "2")],
      f,
      repo,
      1
    );
    expect(names(f)).toEqual(["a", "1", "2"]);
    expect(failed).toEqual(["broken"]);
    expect(landed.map((l) => l.index)).toEqual([1, 2]);
  });

  it("keeps text as a string, even when the browser calls it octet-stream", async () => {
    const f = folder();
    const octet = { type: "application/octet-stream" };
    await handleFilesDrop(
      [
        new File(["a"], "a.amtext", octet),
        new File(["k"], "k.knitout", octet),
        new File(["j"], "j.js", { type: "text/javascript" }),
        new File(["n"], "n.json", { type: "application/json" }),
        new File([new Uint8Array([0, 1])], "b.bin", octet),
      ],
      f,
      repo,
      0
    );
    const files = await Promise.all(
      f.doc()!.docs.map(async (d) => (await repo.find<UnixFileEntry>(d.url)).doc()!)
    );
    expect(files.map((file) => file.content)).toEqual([
      "a",
      "k",
      "j",
      "n",
      new Uint8Array([0, 1]),
    ]);
    expect(files.map((file) => file.mimeType)).toEqual([
      "text/plain",
      "text/plain",
      "text/javascript",
      "application/json",
      "application/octet-stream",
    ]);
  });
});

describe("executeDrop", () => {
  const drag = (urls: AutomergeUrl[]) => ({
    draggedIds: urls,
    draggedUrls: urls,
    sourceToolId: "",
    copyMode: false,
  });

  it("moves to exactly the spot, and says where it landed", async () => {
    const root = folder("a", "b", "c", "d");
    const a = root.doc()!.docs[0].url;
    // drag "a" below "c": it ends up between c and d
    const landed = await executeDrop(
      drag([a]),
      rowSpot(row(root.url, 2), "below"),
      repo,
      root,
      true
    );
    expect(names(root)).toEqual(["b", "c", "a", "d"]);
    expect(landed).toEqual([{ folderUrl: root.url, index: 2, url: a }]);
  });

  it("dropping a row back onto itself does nothing, quietly", async () => {
    const root = folder("a", "b");
    const a = root.doc()!.docs[0].url;
    const landed = await executeDrop(
      drag([a]),
      rowSpot(row(root.url, 0), "above"),
      repo,
      root,
      true
    );
    expect(landed).toBeNull();
    expect(names(root)).toEqual(["a", "b"]);
  });

  it("says why when a folder is dropped into itself", async () => {
    const inner = folder("x");
    const root = repo.create<FolderDoc>({
      title: "root",
      docs: [{ name: "inner", type: "folder", url: inner.url }],
    });
    const spot = rowSpot(
      { id: inner.url, url: inner.url, parentUrl: root.url, index: 0 },
      "inside"
    );
    await expect(
      executeDrop(drag([inner.url]), spot, repo, root, true)
    ).rejects.toThrow(DropError);
    expect(names(root)).toEqual(["inner"]);
  });

  it("from another view, adds a link at the spot", async () => {
    const root = folder("a", "b");
    const other = repo.create({ name: "z" }).url;
    const landed = await executeDrop(
      { ...drag([other]), draggedItems: [{ url: other, name: "z", type: "x" }] },
      endSpot(root.url, 2),
      repo,
      root,
      false
    );
    expect(names(root)).toEqual(["a", "b", "z"]);
    expect(landed).toEqual([{ folderUrl: root.url, index: 2, url: other }]);
  });
});
