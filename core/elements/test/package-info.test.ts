import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import * as Automerge from "@automerge/automerge";
import {
  bareAutomergeUrl,
  pinnedHeads,
  readClaims,
  readHistory,
} from "../src/package-info.js";
import { packages } from "@inkandswitch/patchwork-filesystem";

describe("automerge urls", () => {
  it("reads the heads a url is pinned to", () => {
    expect(pinnedHeads("automerge:abc#h1|h2")).toEqual(["h1", "h2"]);
    expect(pinnedHeads("automerge:abc")).toEqual([]);
  });

  it("drops the pin for the bare url", () => {
    expect(bareAutomergeUrl("automerge:abc#h1|h2")).toBe("automerge:abc");
  });
});

describe("readClaims", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("walks up past dist/ to an http package's package.json", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url === "https://example.com/tool/package.json")
        return new Response(
          JSON.stringify({
            name: "tool",
            version: "1.2.3",
            author: { name: "Mimi", email: "mimi@example.com" },
            plugins: [{ id: "t", name: "T", supportedDatatypes: "thing" }],
          })
        );
      return new Response("", { status: 404 });
    });
    const claims = await readClaims("https://example.com/tool/dist/index.js");
    expect(fetched).toEqual([
      "https://example.com/tool/dist/package.json",
      "https://example.com/tool/package.json",
    ]);
    expect(claims).toMatchObject({
      name: "tool",
      version: "1.2.3",
      author: "Mimi <mimi@example.com>",
      plugins: [{ id: "t", name: "T", supportedDatatypes: ["thing"] }],
    });
  });

  it("is undefined when there's no package.json", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await readClaims("https://example.com/a/index.js")).toBeUndefined();
  });
});

describe("readClaims and the package database", () => {
  const key = "https://db.example.com/pkg/index.js";
  const add = (packageJson: any, importUrl = key) =>
    packages.add({
      key,
      version: "1",
      importUrl,
      packageJson,
      plugins: [],
      addedBy: { by: "js", url: key, stack: "" },
    } as any);
  afterEach(() => {
    packages.remove(key);
    vi.unstubAllGlobals();
  });

  it("readClaims uses the database without fetching", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    add({ name: "from-db", version: "2.0.0" });
    expect(await readClaims(key)).toMatchObject({ name: "from-db", version: "2.0.0" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches for a different pinned version", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    add({ name: "from-db" });
    expect(await readClaims(key + "#abc")).toBeUndefined();
    expect(fetch).toHaveBeenCalled();
  });

  it("fetches for a different pinned version in a service-worker url", async () => {
    const bare = generateAutomergeUrl();
    const heads = Automerge.getHeads(Automerge.change(Automerge.init(), (d: any) => { d.a = 1; }));
    const doc = encodeURIComponent(bare);
    const key = `https://host.example.com/${doc}/index.js`;
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    packages.add({
      key,
      version: "1",
      importUrl: key,
      packageJson: { name: "from-db" },
      plugins: [],
      addedBy: { by: "js", url: key, stack: "" },
    } as any);
    try {
      const pinned = `https://host.example.com/${encodeURIComponent(
        stringifyAutomergeUrl({ documentId: parseAutomergeUrl(bare).documentId, heads: encodeHeads(heads) }),
      )}/index.js`;
      expect(await readClaims(pinned)).toBeUndefined();
      expect(fetch).toHaveBeenCalled();
      expect(await readClaims(key)).toMatchObject({ name: "from-db" });
    } finally {
      packages.remove(key);
    }
  });

  it("readClaims lists patchwork.plugins", async () => {
    add({
      name: "p",
      patchwork: {
        plugins: {
          "patchwork:tool": {
            a: { name: "A", supportedDatatypes: ["x"], export: "./a" },
          },
        },
      },
    });
    expect((await readClaims(key))?.plugins).toEqual([
      { id: "a", name: "A", type: "patchwork:tool", supportedDatatypes: ["x"] },
    ]);
  });
});

describe("readHistory", () => {
  it("counts changes per writer, most first, from the bare url", async () => {
    let doc = Automerge.from({ n: 0 }, { actor: "aaaa" });
    doc = Automerge.change(doc, (d) => {
      d.n = 1;
    });
    let theirs = Automerge.clone(doc, { actor: "bbbb" });
    theirs = Automerge.change(theirs, (d) => {
      d.n = 2;
    });
    doc = Automerge.merge(doc, theirs);
    const asked: string[] = [];
    // only `find` is read, so a plain doc stands in for the repo's handle
    const repo = {
      find: async (url: string) => {
        asked.push(url);
        return { doc: () => doc, heads: () => Automerge.getHeads(doc) };
      },
    } as unknown as Repo;

    const history = await readHistory(repo, "automerge:abc#h1|h2");
    expect(asked).toEqual(["automerge:abc"]);
    expect(history.heads).toEqual(Automerge.getHeads(doc));
    expect(history.changes).toBe(3);
    expect(history.writers.map((w) => [w.actor, w.changes])).toEqual([
      ["aaaa", 2],
      ["bbbb", 1],
    ]);
  });
});
