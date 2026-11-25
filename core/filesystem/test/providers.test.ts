import { describe, it, expect } from "vitest";
import { ImmutableString } from "@automerge/automerge";
import { generateAutomergeUrl } from "@automerge/automerge-repo";
import {
  directoryProvider,
  folderProvider,
  providerFor,
} from "../src/providers.js";

const [A, B] = Array.from({ length: 2 }, generateAutomergeUrl);

describe("directoryProvider", () => {
  it("matches the longest prefix", () => {
    const doc = { dist: { other: A }, "dist/index.js": B };
    expect(directoryProvider.lookup(doc, ["dist", "index.js"])).toEqual({
      child: { name: "dist/index.js", link: B },
      consumed: 2,
    });
  });

  it("returns a nested object as a value child", () => {
    const doc = { dist: { "index.js": A } };
    expect(directoryProvider.lookup(doc, ["dist", "index.js"])).toEqual({
      child: { name: "dist", value: { "index.js": A } },
      consumed: 1,
    });
  });

  it("steps into a list by index", () => {
    const doc = { nested: [{ content: "ok" }, A] };
    expect(directoryProvider.lookup(doc.nested, ["1"])).toEqual({
      child: { name: "1", link: A },
      consumed: 1,
    });
    expect(directoryProvider.list(doc.nested)).toEqual([
      { name: "0", value: { content: "ok" } },
      { name: "1", link: A },
    ]);
  });

  it("reads ImmutableString links", () => {
    const doc = { "a.js": new ImmutableString(A) };
    expect(directoryProvider.lookup(doc, ["a.js"])?.child).toEqual({
      name: "a.js",
      link: A,
    });
  });

  it("does not list @patchwork", () => {
    const doc = { "@patchwork": { type: "directory" }, "a.js": A };
    expect(directoryProvider.list(doc)).toEqual([{ name: "a.js", link: A }]);
  });
});

describe("folderProvider", () => {
  it("first entry with the name wins", () => {
    const doc = {
      docs: [
        { name: "a", type: "x", url: A },
        { name: "a", type: "x", url: B },
      ],
    };
    expect(folderProvider.lookup(doc, ["a", "b"])).toEqual({
      child: { name: "a", link: A },
      consumed: 1,
    });
  });

  it("skips entries that aren't objects", () => {
    const doc = { docs: [null, { name: "a", type: "x", url: A }] };
    expect(folderProvider.lookup(doc, ["a"])?.child).toEqual({
      name: "a",
      link: A,
    });
    expect(folderProvider.list(doc)).toEqual([{ name: "a", link: A }]);
  });

  it("misses an unknown name", () => {
    expect(folderProvider.lookup({ docs: [] }, ["a"])).toBeUndefined();
  });

  it("lists the entries that link somewhere", () => {
    const doc = {
      docs: [
        { name: "a", type: "x", url: A },
        { name: "broken", type: "x", url: "nope" },
      ],
    };
    expect(folderProvider.list(doc)).toEqual([{ name: "a", link: A }]);
  });
});

describe("providerFor", () => {
  it("checks directory before folder", () => {
    expect(
      providerFor({ "@patchwork": { type: "directory" }, docs: [] })
    ).toBe(directoryProvider);
    expect(providerFor({ docs: [] })).toBe(folderProvider);
    expect(
      providerFor({ "@patchwork": { type: "file" }, content: "x" })
    ).toBeUndefined();
  });
});
