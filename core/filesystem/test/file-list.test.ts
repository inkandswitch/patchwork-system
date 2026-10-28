import { describe, it, expect } from "vitest";
import { parseAutomergeUrl } from "@automerge/automerge-repo";
import { formatHeads, livePath, parseHeads } from "../src/paths.js";
import { IncompleteFileListError, pinnedPath, readPath } from "../src/walk.js";
import { contentHash, toBytes } from "../src/content-hash.js";
import { buildFileList, canonicalJson, parseFileList } from "../src/file-list.js";
import { chain, fixture } from "./namespace-fixture.js";

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
