import { describe, expect, it } from "vitest";
import { generateAutomergeUrl, ImmutableString } from "@automerge/automerge-repo";
import { directoryLinks, folderLinks, isDirectoryDoc } from "./links.js";

const a = generateAutomergeUrl();
const b = generateAutomergeUrl();
const c = generateAutomergeUrl();

describe("folderLinks", () => {
  it("reads links whose fields are ImmutableStrings", () => {
    const folder = {
      "@patchwork": { type: "folder" },
      title: "pushwork",
      docs: [
        { name: new ImmutableString("a.ts"), type: new ImmutableString("ts"), url: new ImmutableString(a) },
        { name: "b", type: "folder", url: b },
      ],
    };
    expect(folderLinks(folder)).toEqual([
      { name: "a.ts", type: "ts", url: a },
      { name: "b", type: "folder", url: b },
    ]);
  });

  it("skips links without a usable url, and copes with no docs", () => {
    expect(folderLinks({ docs: [{ name: "x", type: "", url: "nope" }] })).toEqual([]);
    expect(folderLinks({})).toEqual([]);
  });
});

describe("directoryLinks", () => {
  const dir = {
    "@patchwork": { type: "directory", title: "repo" },
    lastSyncAt: 1,
    "README.md": new ImmutableString(a),
    "src/index.js": new ImmutableString(b),
    "src/lib/util.js": c,
  };

  it("recognises a directory doc", () => {
    expect(isDirectoryDoc(dir)).toBe(true);
    expect(isDirectoryDoc({ "@patchwork": { type: "folder" }, docs: [] })).toBe(false);
  });

  it("lists the top level, subdirectories first", () => {
    expect(directoryLinks(dir)).toEqual([
      { name: "src", type: "folder", path: "src" },
      { name: "README.md", type: "md", url: a },
    ]);
  });

  it("lists a subdirectory", () => {
    expect(directoryLinks(dir, "src")).toEqual([
      { name: "lib", type: "folder", path: "src/lib" },
      { name: "index.js", type: "js", url: b },
    ]);
    expect(directoryLinks(dir, "src/lib")).toEqual([
      { name: "util.js", type: "js", url: c },
    ]);
    expect(directoryLinks(dir, "gone")).toEqual([]);
  });
});
