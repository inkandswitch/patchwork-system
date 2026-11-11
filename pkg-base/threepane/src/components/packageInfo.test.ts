import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@automerge/automerge-repo/slim";
import * as Automerge from "@automerge/automerge";
import {
  bareAutomergeUrl,
  pinnedHeads,
  readClaims,
  readHistory,
} from "./packageInfo";

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
