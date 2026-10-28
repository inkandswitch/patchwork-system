import { describe, it, expect } from "vitest";
import { parseAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import { livePath } from "../src/paths.js";
import { listFiles, pinnedPath, readPath, type ListedFile } from "../src/walk.js";
import { file, fixture, folder } from "./namespace-fixture.js";

const decode = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

async function collect(files: AsyncIterable<ListedFile>) {
  const out: ListedFile[] = [];
  for await (const f of files) out.push(f);
  return out.sort((a, b) => a.tail.localeCompare(b.tail));
}

const idOf = (url: AutomergeUrl) => parseAutomergeUrl(url).documentId;

describe("readPath", () => {
  it("reads a file and its pinned form", async () => {
    const { repo, a, accounts } = await fixture();
    const path = livePath(a, ["packages", "foo", "dist", "index.js"]);
    const read = await readPath(repo, path, { accounts });
    expect(read && decode(read.content)).toBe("mine");
    expect(read?.type).toBe("text/plain");
    expect(read?.canonical).toBe(false);
    expect(read?.pinned).toBe(await pinnedPath(repo, path, { accounts }));
  });

  it("reads nothing for a path that doesn't resolve", async () => {
    const { repo, a, accounts } = await fixture();
    expect(
      await readPath(repo, livePath(a, ["packages", "nope"]), { accounts })
    ).toBeUndefined();
  });
});

describe("listFiles", () => {
  it("lists a directory package's files", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const listed = await listFiles(repo, prefix!, { accounts });
    expect(listed?.prefix).toBe(prefix);
    const files = await collect(listed!.files);
    expect(files.map((f) => f.tail)).toEqual(["", "dist/index.js", "package.json"]);
    const index = files.find((f) => f.tail === "dist/index.js")!;
    expect(index.documentId).toBe(idOf((minePkg.doc() as any)["dist/index.js"]));
    expect(files[0].documentId).toBe(minePkg.documentId);
  });

  it("lists a folder's leaves and skips its subfolders", async () => {
    const { repo, a, accounts, foo } = await fixture();
    const sub = folder(repo, { inner: file(repo, "inner").url });
    foo.change((d: any) => d.docs.push({ name: "sub", type: "folder", url: sub.url }));
    const prefix = await pinnedPath(repo, livePath(a, ["Projects", "foo"]), { accounts });
    const files = await collect((await listFiles(repo, prefix!, { accounts }))!.files);
    expect(files.map((f) => f.tail)).toEqual(["", "notes"]);
  });

  it("lists nested values inside a directory doc", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => (d.dist = { "a.js": "x" }));
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const files = await collect((await listFiles(repo, prefix!, { accounts }))!.files);
    expect(files.map((f) => f.tail)).toContain("dist/a.js");
    expect(files.find((f) => f.tail === "dist/a.js")?.documentId).toBe(minePkg.documentId);
  });

  it("encodes names in tails", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => (d["my file@1.js"] = file(repo, "spaced").url));
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const files = await collect((await listFiles(repo, prefix!, { accounts }))!.files);
    expect(files.map((f) => f.tail)).toContain("my%20file%401.js");
  });

  it("lists a flat key over a nested one at the same path, as the walk finds it", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => {
      d["x/y"] = file(repo, "flat").url;
      d.x = { y: "nested" };
    });
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const files = await collect((await listFiles(repo, prefix!, { accounts }))!.files);
    const xy = files.filter((f) => f.tail === "x/y");
    expect(xy).toHaveLength(1);
    expect(decode(xy[0].content)).toBe("flat");
  });

  it("agrees with readPath for every file it lists", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => {
      d.dist = { "a.js": "x" };
      d["x/y"] = file(repo, "flat").url;
      d.x = { y: "nested" };
    });
    for (const names of [["packages", "foo"], ["Projects", "foo"]]) {
      const prefix = await pinnedPath(repo, livePath(a, names), { accounts });
      const files = await collect((await listFiles(repo, prefix!, { accounts }))!.files);
      expect(files.length).toBeGreaterThan(1);
      for (const f of files) {
        const read = await readPath(repo, f.tail ? `${prefix}/${f.tail}` : prefix!, { accounts });
        expect([f.tail, read && decode(read.content), read?.type]).toEqual([
          f.tail,
          decode(f.content),
          f.type,
        ]);
      }
    }
  });

  it("lists the package a file path is in", async () => {
    const { repo, a, accounts } = await fixture();
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const listed = await listFiles(repo, `${prefix}/dist/index.js`, { accounts });
    expect(listed?.prefix).toBe(prefix);
    expect((await collect(listed!.files)).map((f) => f.tail)).toContain("dist/index.js");
  });

  it("lists the package for a path that ends inside it", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => (d.dist = { "a.js": "x" }));
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    expect((await listFiles(repo, `${prefix}/dist`, { accounts }))?.prefix).toBe(prefix);
  });

  it("says which files it couldn't read", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    const bad = (minePkg.doc() as any)["package.json"] as string;
    const find = (url: AutomergeUrl) =>
      url === bad ? Promise.reject(new Error("unavailable")) : repo.find(url);
    const prefix = await pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts });
    const listed = await listFiles(repo, prefix!, { accounts, find });
    expect(listed?.missing).toEqual(["package.json"]);
    expect(listed?.files.map((f) => f.tail)).not.toContain("package.json");
  });

  it("lists nothing for a path that isn't canonical", async () => {
    const { repo, a, accounts } = await fixture();
    expect(
      await listFiles(repo, livePath(a, ["packages", "foo"]), { accounts })
    ).toBeUndefined();
  });
});
