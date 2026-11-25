import { describe, it, expect, vi, afterEach } from "vitest";
import { ImmutableString } from "@automerge/automerge";
import { generateAutomergeUrl } from "@automerge/automerge-repo";
import {
  accountBindings,
  accountProvider,
  directoryProvider,
  folderProvider,
  providerFor,
} from "../src/providers.js";

const [A, B, R, P1, P2] = Array.from({ length: 5 }, generateAutomergeUrl);
const account = (rest: object) => ({
  "@patchwork": { type: "account" as const },
  ...rest,
});

afterEach(() => vi.restoreAllMocks());

describe("accountProvider", () => {
  const doc = account({
    namespace: {
      "/": [{ url: R }],
      "/packages": [{ url: P1 }, { url: P2 }],
    },
  });

  it("looks a mount up by name and consumes it", () => {
    expect(accountProvider.lookup(doc, ["packages", "foo"])).toEqual({
      child: { name: "packages", union: [P1, P2] },
      consumed: 1,
    });
  });

  it("sends any other name to / without consuming it", () => {
    expect(accountProvider.lookup(doc, ["Projects"])).toEqual({
      child: { name: "", union: [R] },
      consumed: 0,
    });
  });

  it("falls back to rootFolderUrl with no namespace, or no / key", () => {
    for (const d of [
      account({ rootFolderUrl: R }),
      account({ rootFolderUrl: R, namespace: { "/packages": [{ url: P1 }] } }),
    ]) {
      expect(accountProvider.lookup(d, ["Projects"])?.child).toEqual({
        name: "",
        union: [R],
      });
    }
  });

  it("finds nothing with neither namespace nor rootFolderUrl", () => {
    expect(accountProvider.lookup(account({}), ["x"])).toBeUndefined();
    expect(accountProvider.list(account({}))).toEqual([]);
  });

  it("skips malformed mounts and bindings with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bindings = accountBindings(
      account({
        namespace: {
          "/": [{ url: R }, { url: "nope" }, null],
          packages: [{ url: P1 }],
          "/a/b": [{ url: P1 }],
          "/x@y": [{ url: P1 }],
          "/ok": "not an array",
        },
      }) as never
    );
    expect([...bindings]).toEqual([["/", [R]]]);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to rootFolderUrl when every / binding is malformed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bindings = accountBindings(
      account({ rootFolderUrl: R, namespace: { "/": [{ url: "nope" }] } }) as never
    );
    expect(bindings.get("/")).toEqual([R]);
  });

  it("warns about a malformed mount once, however often it's read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = account({
      namespace: { "/once@only": [{ url: R }], "/": [{ url: R }] },
    });
    for (let i = 0; i < 5; i++) accountProvider.lookup(doc, ["a"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("lists every mount as a union child, / first", () => {
    expect(accountProvider.list(doc)).toEqual([
      { name: "", union: [R] },
      { name: "packages", union: [P1, P2] },
    ]);
  });
});

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
  it("checks account, then directory, then folder", () => {
    expect(providerFor(account({ docs: [] }))).toBe(accountProvider);
    expect(
      providerFor({ "@patchwork": { type: "directory" }, docs: [] })
    ).toBe(directoryProvider);
    expect(providerFor({ docs: [] })).toBe(folderProvider);
    expect(
      providerFor({ "@patchwork": { type: "file" }, content: "x" })
    ).toBeUndefined();
  });
});
