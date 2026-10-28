import { describe, it, expect, vi, afterEach } from "vitest";
import { ImmutableString } from "@automerge/automerge";
import { generateAutomergeUrl } from "@automerge/automerge-repo";
import {
  accountBindings,
  accountProvider,
  branchesProvider,
  directoryProvider,
  folderProvider,
  providerFor,
} from "../src/providers.js";

const [R, P1, P2, A, B] = Array.from({ length: 5 }, generateAutomergeUrl);
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
          "/": [{ url: R }, { url: "nope" }],
          packages: [{ url: P1 }],
          "/a/b": [{ url: P1 }],
          "/x@y": [{ url: P1 }],
          "/ok": "not an array",
        },
      })
    );
    expect([...bindings]).toEqual([["/", [R]]]);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to rootFolderUrl when every / binding is malformed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bindings = accountBindings(
      account({ rootFolderUrl: R, namespace: { "/": [{ url: "nope" }] } })
    );
    expect(bindings.get("/")).toEqual([R]);
  });

  it("lists every mount as a union child", () => {
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

  it("misses an unknown name", () => {
    expect(folderProvider.lookup({ docs: [] }, ["a"])).toBeUndefined();
  });
});

describe("branchesProvider", () => {
  const doc = {
    "@patchwork": { type: "branches" },
    branches: { default: A, feature: B },
  };

  it("follows a named branch", () => {
    expect(branchesProvider.lookup(doc, ["feature", "x"])).toEqual({
      child: { name: "feature", link: B },
      consumed: 1,
    });
  });

  it("falls through to default for any other name", () => {
    expect(branchesProvider.lookup(doc, ["dist", "index.js"])).toEqual({
      child: { name: "default", link: A },
      consumed: 0,
    });
  });

  it("finds nothing with no default branch", () => {
    const none = { "@patchwork": { type: "branches" }, branches: { x: B } };
    expect(branchesProvider.lookup(none, ["y"])).toBeUndefined();
  });
});

describe("providerFor", () => {
  it("checks account, directory, folder, branches in order", () => {
    expect(providerFor(account({ docs: [] }))).toBe(accountProvider);
    expect(
      providerFor({ "@patchwork": { type: "directory" }, docs: [] })
    ).toBe(directoryProvider);
    expect(providerFor({ docs: [] })).toBe(folderProvider);
    expect(
      providerFor({ "@patchwork": { type: "branches" }, branches: {} })
    ).toBe(branchesProvider);
    expect(
      providerFor({ "@patchwork": { type: "file" }, content: "x" })
    ).toBeUndefined();
  });
});
