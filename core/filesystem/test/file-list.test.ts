import { describe, it, expect } from "vitest";
import { parseAutomergeUrl } from "@automerge/automerge-repo";
import { formatHeads, livePath, parseHeads } from "../src/paths.js";
import { IncompleteFileListError, pinnedPath, readPath } from "../src/walk.js";
import { contentHash, toBytes } from "../src/content-hash.js";
import { buildFileList, canonicalJson, parseFileList } from "../src/file-list.js";
import { chain, file, fixture, folder } from "./namespace-fixture.js";

const decode = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

describe("canonicalJson", () => {
  it("sorts keys at every level and leaves no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[2,{"e":2,"f":1}],"d":1},"b":1}'
    );
  });
});

describe("buildFileList", () => {
  it("is canonical: building it twice gives the same bytes and hash", async () => {
    const { repo, a, accounts } = await fixture();
    const prefix = await chain(repo, livePath(a, ["packages", "foo"]), accounts);
    const first = await buildFileList(repo, prefix!, { accounts });
    const second = await buildFileList(repo, prefix!, { accounts });
    expect(first?.bytes).toEqual(second?.bytes);
    expect(first?.listHash).toBe(await contentHash(first!.bytes));
    expect(parseFileList(first!.bytes)).toEqual(first?.list);
  });

  it("records each file's hash, type and heads, and no document ids", async () => {
    const { repo, a, accounts, minePkg, mine, account } = await fixture();
    const prefix = await chain(repo, livePath(a, ["packages", "foo"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts });
    const fileUrl = (minePkg.doc() as any)["dist/index.js"] as string;
    const file = await repo.find(fileUrl as any);
    expect(built?.list.files["dist/index.js"]).toEqual({
      sha256: await contentHash(toBytes("mine")),
      type: "text/plain",
      heads: formatHeads(file.heads()),
      store: true,
    });
    const text = new TextDecoder().decode(built!.bytes);
    for (const doc of [minePkg, mine, account, file]) {
      expect(text).not.toContain(doc.documentId);
    }
    expect(text).not.toContain(parseAutomergeUrl(fileUrl as any).documentId);
  });

  it("lists a file named __proto__ like any other", async () => {
    const { repo, a, accounts, foo } = await fixture();
    foo.change((d: any) => d.docs.push({ name: "__proto__", type: "x", url: file(repo, "p").url }));
    const prefix = await chain(repo, livePath(a, ["Projects", "foo"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts });
    expect(Object.hasOwn(built!.list.files, "__proto__")).toBe(true);
    expect(new TextDecoder().decode(built!.bytes)).toContain('"__proto__":');
    expect(Object.hasOwn(parseFileList(built!.bytes)!.files, "__proto__")).toBe(true);
  });

  it("lists only what it's asked to", async () => {
    const { repo, a, accounts } = await fixture();
    const prefix = await chain(repo, livePath(a, ["packages", "foo"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts, only: ["dist/index.js"] });
    expect(Object.keys(built!.list.files)).toEqual(["dist/index.js"]);
  });

  it("stores protected content only through /packages", async () => {
    const { repo, a, accounts } = await fixture();
    const isProtected = () => true;
    const projects = await chain(repo, livePath(a, ["Projects", "foo"]), accounts);
    const pkg = await chain(repo, livePath(a, ["packages", "foo"]), accounts);
    const userList = await buildFileList(repo, projects!, { accounts, isProtected });
    const pkgList = await buildFileList(repo, pkg!, { accounts, isProtected });
    expect(userList?.list.files.notes.store).toBe(false);
    expect(pkgList?.list.files["dist/index.js"].store).toBe(true);
  });

  it("reads a file at the heads its list recorded, after it changed", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    const prefix = await chain(repo, livePath(a, ["packages", "foo"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts });
    const entry = built!.list.files["dist/index.js"];
    const file = await repo.find((minePkg.doc() as any)["dist/index.js"]);
    (file as any).change((d: any) => (d.content = "changed"));

    const now = await readPath(repo, `${prefix}/dist/index.js`, { accounts });
    expect(decode(now!.content)).toBe("changed");
    const then = await readPath(repo, `${prefix}/dist/index.js`, {
      accounts,
      heads: parseHeads(entry.heads!),
    });
    expect(decode(then!.content)).toBe("mine");
  });
});

describe("pinnedPath", () => {
  it("refuses to pin a list that's missing files", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    const bad = (minePkg.doc() as any)["package.json"] as string;
    const find = (url: any) =>
      url === bad ? Promise.reject(new Error("unavailable")) : repo.find(url);
    const pinning = pinnedPath(repo, livePath(a, ["packages", "foo"]), { accounts, find });
    await expect(pinning).rejects.toBeInstanceOf(IncompleteFileListError);
    await expect(pinning).rejects.toMatchObject({ missing: ["package.json"] });
  });
});

describe("package lists", () => {
  /** A folder package under /packages: package.json, index.js, and sub/x.js. */
  async function folderPackage() {
    const f = await fixture();
    const x = file(f.repo, "x");
    const sub = folder(f.repo, { "x.js": x.url });
    const pkg = folder(f.repo, {
      "package.json": file(f.repo, '{"main":"index.js"}').url,
      "index.js": file(f.repo, "export * from './sub/x.js'").url,
      sub: sub.url,
    });
    f.mine.change((d: any) => d.docs.push({ name: "fpkg", type: "folder", url: pkg.url }));
    const prefix = await chain(f.repo, livePath(f.a, ["packages", "fpkg"]), f.accounts);
    return { ...f, x, sub, pkg, prefix: prefix! };
  }

  it("lists a package's nested folders deep", async () => {
    const { repo, accounts, prefix } = await folderPackage();
    const built = await buildFileList(repo, prefix, { accounts });
    expect(Object.keys(built!.list.files)).toEqual(
      expect.arrayContaining(["package.json", "index.js", "sub/x.js"])
    );
  });

  it("lists a user folder shallow", async () => {
    const { repo, a, accounts, foo } = await fixture();
    const sub = folder(repo, { inner: file(repo, "inner").url });
    foo.change((d: any) => d.docs.push({ name: "sub", type: "folder", url: sub.url }));
    const prefix = await chain(repo, livePath(a, ["Projects", "foo"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts });
    expect(Object.keys(built!.list.files).some((tail) => tail.startsWith("sub/"))).toBe(false);
  });

  it("reads a nested file at its recorded heads", async () => {
    const { repo, accounts, prefix, x } = await folderPackage();
    const built = await buildFileList(repo, prefix, { accounts });
    const entry = built!.list.files["sub/x.js"];
    x.change((d: any) => (d.content = "changed"));
    const then = await readPath(repo, `${prefix}/sub/x.js`, {
      accounts,
      heads: parseHeads(entry.heads!),
    });
    expect(decode(then!.content)).toBe("x");
  });

  it("records the heads of a nested doc that holds values, and reads them there", async () => {
    const { repo, a, accounts, pkg } = await folderPackage();
    const dir = repo.create<any>({
      "@patchwork": { type: "directory" },
      "a.js": { content: "old", mimeType: "text/javascript" },
    });
    pkg.change((d: any) => d.docs.push({ name: "dir", type: "directory", url: dir.url }));
    const prefix = await chain(repo, livePath(a, ["packages", "fpkg"]), accounts);
    const built = await buildFileList(repo, prefix!, { accounts });
    const entry = built!.list.files["dir/a.js"];
    expect(entry?.heads).toBeDefined();
    dir.change((d: any) => (d["a.js"].content = "new"));
    const then = await readPath(repo, `${built!.prefix}/dir/a.js`, {
      accounts,
      heads: parseHeads(entry!.heads!),
    });
    expect(decode(then!.content)).toBe("old");
  });

  it("pins a live path to a folder with the folder's whole list", async () => {
    const { repo, a, accounts } = await folderPackage();
    const pinned = await pinnedPath(repo, livePath(a, ["packages", "fpkg"]), {
      accounts,
      only: "end",
    });
    const list = parseFileList(pinned!.list!)!;
    expect(Object.keys(list.files)).toEqual(expect.arrayContaining(["package.json", "sub/x.js"]));
  });
});

describe("listFiles concurrency", () => {
  it("reads a nested folder's files several at a time", async () => {
    const f = await fixture();
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}.js`, file(f.repo, `${i}`).url])
    );
    const dist = folder(f.repo, files);
    const pkg = folder(f.repo, {
      "package.json": file(f.repo, '{"main":"dist/f0.js"}').url,
      dist: dist.url,
    });
    f.mine.change((d: any) => d.docs.push({ name: "big", type: "folder", url: pkg.url }));
    const prefix = await chain(f.repo, livePath(f.a, ["packages", "big"]), f.accounts);
    let active = 0;
    let peak = 0;
    const findFile = async (url: any) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return f.repo.find(url);
    };
    const built = await buildFileList(f.repo, prefix!, { accounts: f.accounts, findFile });
    expect(Object.keys(built!.list.files).filter((t) => t.startsWith("dist/"))).toHaveLength(20);
    expect(peak).toBeGreaterThanOrEqual(4);
  });
});
