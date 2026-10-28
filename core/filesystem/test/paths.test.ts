import { describe, it, expect } from "vitest";
import {
  docStep,
  formatHeads,
  idhash,
  livePath,
  parseHeads,
  parsePath,
  PathSyntaxError,
} from "../src/paths.js";

describe("idhash", () => {
  it("is base58 of the first 12 bytes of sha-256 over the document id", async () => {
    expect(await idhash("2j9knpCseyhnK8izDmLpGP5WMdZQ")).toBe(
      "vjRneszhMkDwr5tb"
    );
  });
});

describe("heads", () => {
  it("sorts so one set of heads is one string", () => {
    expect(formatHeads(["c", "a", "b"])).toBe("a.b.c");
    expect(formatHeads(["b", "a"])).toBe(formatHeads(["a", "b"]));
  });

  it("parses only base58 parts", () => {
    expect(parseHeads("a.b")).toEqual(["a", "b"]);
    expect(parseHeads("a.0")).toBeUndefined();
    expect(parseHeads("a..b")).toBeUndefined();
    expect(parseHeads("")).toBeUndefined();
  });
});

describe("parsePath", () => {
  it("round-trips a live path, encoding each name", () => {
    const names = ["Projects", "a/b", "x@y", "50%", "my notes", "日本"];
    const path = livePath("acct", names);
    // a slash inside a name is encoded, so it doesn't split the name
    expect(path.split("/")).toHaveLength(1 + names.length);
    expect(parsePath(path)).toEqual({
      root: { kind: "account", acctHash: "acct" },
      segments: names.map((name) => ({ kind: "name", name })),
    });
  });

  it("reads a pinned path's doc steps and plain names", () => {
    const p = parsePath("acct@h2.h1/packages/mine@h3/foo@h4/dist/index.js");
    expect(p.root).toEqual({
      kind: "account",
      acctHash: "acct",
      heads: ["h1", "h2"],
    });
    expect(p.segments.map((s) => s.kind)).toEqual([
      "name",
      "doc",
      "doc",
      "name",
      "name",
    ]);
    expect(p.segments[1]).toEqual({
      kind: "doc",
      idhash: "mine",
      heads: ["h3"],
      raw: "mine@h3",
    });
  });

  it("reads a share root", () => {
    expect(
      parsePath("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ@h1/x").root
    ).toEqual({
      kind: "share",
      documentId: "2j9knpCseyhnK8izDmLpGP5WMdZQ",
      heads: ["h1"],
    });
    // the router and the service worker hand over encoded segments
    expect(
      parsePath("automerge%3A2j9knpCseyhnK8izDmLpGP5WMdZQ@h1").root.kind
    ).toBe("share");
  });

  it("treats an encoded @ as part of a name", () => {
    expect(parsePath("acct/a%40b").segments).toEqual([
      { kind: "name", name: "a@b" },
    ]);
  });

  it("ignores a leading slash and empty segments", () => {
    expect(parsePath("/acct//a/").segments).toEqual([
      { kind: "name", name: "a" },
    ]);
  });

  it("rejects a share root without heads, an empty path, and a bad root", () => {
    expect(() => parsePath("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ")).toThrow(
      PathSyntaxError
    );
    expect(() => parsePath("")).toThrow(PathSyntaxError);
    expect(() => parsePath("acct@0")).toThrow(PathSyntaxError);
    expect(() => parsePath("automerge:not-an-id@h1")).toThrow(PathSyntaxError);
  });
});

describe("file list hashes", () => {
  it("reads a doc step's file list hash", () => {
    expect(parsePath("acct@h/foo@h~AbC-_9/dist/x.js").segments[0]).toEqual({
      kind: "doc",
      idhash: "foo",
      heads: ["h"],
      listHash: "AbC-_9",
      raw: "foo@h~AbC-_9",
    });
    expect(docStep("foo", ["b", "a"], "L")).toBe("foo@a.b~L");
    expect(docStep("foo", ["a"])).toBe("foo@a");
  });

  it("reads a root's file list hash", () => {
    expect(parsePath("acct@h~L").root).toEqual({
      kind: "account",
      acctHash: "acct",
      heads: ["h"],
      listHash: "L",
    });
  });

  it("takes a malformed list hash as a name, and refuses it at the root", () => {
    expect(parsePath("acct@h/foo@h~/x").segments[0]).toEqual({ kind: "name", name: "foo@h~" });
    expect(parsePath("acct@h/foo@h~a.b/x").segments[0].kind).toBe("name");
    expect(() => parsePath("acct@h~")).toThrow(PathSyntaxError);
  });
});
