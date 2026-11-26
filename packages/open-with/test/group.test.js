import { describe, expect, it } from "vitest";
import {
  aboutPackage,
  adders,
  atHeads,
  groupTools,
  packageName,
  seenVersions,
  sha256,
  short,
} from "../group.js";

const pkg = (key, ...by) => ({
  key,
  packageJson: { name: key },
  addedBy: by.map((b) => ({ by: b })),
});

describe("groupTools", () => {
  it("one group per id, tools made for the type first, then by name", () => {
    const groups = groupTools(
      [
        { id: "raw", name: "Raw", supportedDatatypes: "*" },
        { id: "md", name: "Markdown", supportedDatatypes: ["markdown"] },
        { id: "b", name: "Board", supportedDatatypes: ["markdown"] },
        { id: "hidden", name: "Hidden", supportedDatatypes: "*", unlisted: true },
        { id: "bar", name: "Bar", supportedDatatypes: "*", forTitleBar: true },
      ],
      "markdown",
      () => undefined
    );
    expect(groups.map((g) => g.id)).toEqual(["b", "md", "raw"]);
  });

  it("lists every package with an id, the one that opens first", () => {
    const listed = { id: "md", name: "Markdown", supportedDatatypes: ["markdown"], package: pkg("a") };
    const viewed = { id: "md", name: "Markdown (dev)", supportedDatatypes: ["markdown"], package: pkg("b") };
    const [group] = groupTools([listed, viewed], "markdown", () => viewed);
    expect(group.copies).toEqual([viewed, listed]);
    expect(group.name).toBe("Markdown (dev)");
  });
});

describe("aboutPackage", () => {
  it("says what the package.json says, and which version it is", () => {
    const about = aboutPackage({
      key: "automerge:abc",
      importUrl: "automerge:abc#h1h1h1h1h1|h2h2h2h2h2",
      version: "h1h1h1h1h1|h2h2h2h2h2",
      addedAt: 0,
      addedBy: [],
      packageJson: {
        title: "Markdown",
        name: "@x/markdown",
        version: "1.2.3",
        author: { name: "Someone" },
        repository: { url: "https://x.test/repo" },
      },
    });
    expect(Object.fromEntries(about)).toEqual({
      name: "@x/markdown",
      version: "1.2.3",
      author: "Someone",
      homepage: "https://x.test/repo",
      heads: "h1h1h1h1 h2h2h2h2",
      url: "automerge:abc#h1h1h1h1h1|h2h2h2h2h2",
    });
  });

  it("calls an http package's version its sha-256", () => {
    const about = aboutPackage({
      key: "https://x.test/p/",
      importUrl: "https://x.test/p/",
      version: "f00d",
      addedBy: [],
    });
    expect(about).toContainEqual(["sha-256", "f00d"]);
  });
});

describe("adders", () => {
  it("names each adder once, with the package lists that have a listed one", () => {
    const entry = {
      addedBy: [
        { by: "package-list", entry: "automerge:pkg" },
        { by: "package-list", entry: "automerge:pkg" },
        { by: "suggested" },
        { by: "js", url: "https://x.test/script.js", stack: "Error" },
      ],
    };
    const lists = { "automerge:pkg": [{ name: "user", url: "automerge:list" }] };
    expect(adders(entry, (listed) => lists[listed] ?? [])).toEqual([
      {
        label: "package list",
        entry: "automerge:pkg",
        lists: [{ name: "user", url: "automerge:list" }],
      },
      { label: "suggested", entry: undefined, lists: [] },
      { label: "js", entry: "https://x.test/script.js", lists: [] },
    ]);
  });
});

describe("versions", () => {
  it("seenVersions is the current one and the saved ones, once each, newest first", () => {
    const old = { version: "a", addedAt: 1 };
    const current = { version: "b", addedAt: 3 };
    const middle = { version: "c", addedAt: 2 };
    expect(seenVersions(current, [old, { version: "b", addedAt: 3 }, middle])).toEqual([
      current,
      middle,
      old,
    ]);
  });

  it("atHeads pins a package doc, and short cuts heads down", () => {
    expect(atHeads("automerge:abc", ["h1", "h2"])).toBe("automerge:abc#h1|h2");
    expect(short("0123456789|abcdefghij")).toBe("01234567 abcdefgh");
  });

  it("sha256 versions a package.json as the database does", async () => {
    expect(await sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("packageName", () => {
  it("prefers a title", () => {
    expect(packageName({ key: "k", packageJson: { title: "T", name: "n" } })).toBe("T");
    expect(packageName({ key: "k" })).toBe("k");
  });
});
