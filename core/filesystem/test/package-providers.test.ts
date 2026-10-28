// Providers a tab passes in (`WalkOptions.providers`), after the built-ins, and
// children offered as sub-documents.
import { describe, it, expect } from "vitest";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { livePath } from "../src/paths.js";
import { getType } from "../src/metadata.js";
import type { Child, PathProvider } from "../src/providers.js";
import { listChildren, listFiles, resolveLivePath, walkPath } from "../src/walk.js";
import { file, fixture } from "./namespace-fixture.js";

type BoardDoc = {
  "@patchwork": { type: "board" };
  links: { name: string; url: AutomergeUrl }[];
  notes?: { content: string; mimeType: string };
};

const listBoard = (node: unknown): Child[] => {
  const board = node as BoardDoc;
  const children: Child[] = board.links.map(({ name, url }) => ({ name, link: url }));
  if (board.notes) children.push({ name: "notes", sub: ["notes"] });
  return children;
};

const board: PathProvider = {
  kind: "board",
  matches: (doc) => getType(doc as BoardDoc) === "board",
  list: listBoard,
  lookup(node, names) {
    const child = listBoard(node).find((c) => c.name === names[0]);
    return child && { child, consumed: 1 };
  },
};

const providers = async (doc: unknown) => (board.matches(doc) ? board : undefined);

async function boardFixture() {
  const base = await fixture();
  const child = file(base.repo, "child");
  const b = base.repo.create<BoardDoc>({
    "@patchwork": { type: "board" },
    links: [{ name: "child", url: child.url }],
    notes: { content: "n", mimeType: "text/plain" },
  });
  base.root.change((d: any) => d.docs.push({ name: "b", type: "board", url: b.url }));
  return { ...base, b, child };
}

describe("extra providers", () => {
  it("walks through a provider it's given, and not without it", async () => {
    const { repo, a, accounts, child } = await boardFixture();
    const path = livePath(a, ["b", "child"]);
    expect((await resolveLivePath(repo, path, { accounts, providers }))?.url).toBe(child.url);
    expect(await resolveLivePath(repo, path, { accounts })).toBeUndefined();
  });

  it("asks the built-ins first", async () => {
    const { repo, a, accounts, notes } = await fixture();
    const greedy: PathProvider = { kind: "greedy", matches: () => true, list: () => [], lookup: () => undefined };
    const handle = await resolveLivePath(repo, livePath(a, ["Projects", "foo", "notes"]), {
      accounts,
      providers: async () => greedy,
    });
    expect(handle?.url).toBe(notes.url);
  });

  it("treats a provider that throws as having no children", async () => {
    const { repo, a, accounts, b } = await boardFixture();
    const broken: PathProvider = {
      ...board,
      list: () => {
        throw new Error("list");
      },
      lookup: () => {
        throw new Error("lookup");
      },
    };
    const options = { accounts, providers: async () => broken };
    expect(await walkPath(repo, livePath(a, ["b", "child"]), options)).toBeUndefined();
    expect(await listChildren(repo, b as DocHandle<unknown>, options.providers)).toEqual([]);
  });

  it("lists a provider's children when given it", async () => {
    const { repo, b } = await boardFixture();
    const names = (await listChildren(repo, b as DocHandle<unknown>, providers)).map((c) => c.name);
    expect(names).toEqual(["child", "notes"]);
  });
});

describe("sub-documents", () => {
  it("ends at a sub-document as a name after the doc's step", async () => {
    const { repo, a, accounts, b } = await boardFixture();
    const end = await walkPath(repo, livePath(a, ["b", "notes"]), { accounts, providers });
    expect(end?.atDocument).toBe(false);
    expect(end?.sub).toEqual(["notes"]);
    expect(end?.handle.documentId).toBe(b.documentId);
    expect(end?.pinned.endsWith("/notes")).toBe(true);
  });

  it("resolves to the sub-handle", async () => {
    const { repo, a, accounts, b } = await boardFixture();
    const handle = await resolveLivePath(repo, livePath(a, ["b", "notes"]), { accounts, providers });
    expect(handle?.url).toBe(b.sub("notes").url);
    expect(handle?.url).toMatch(new RegExp(`^automerge:${b.documentId}/notes`));
    expect((handle?.doc() as any)?.content).toBe("n");
  });

  it("names nothing once the value is gone", async () => {
    const { repo, a, accounts, b } = await boardFixture();
    const sub: PathProvider = {
      ...board,
      list: (node) => [...board.list(node), { name: "gone", sub: ["missing"] }],
      lookup: (node, names) =>
        names[0] === "gone"
          ? { child: { name: "gone", sub: ["missing"] }, consumed: 1 }
          : board.lookup(node, names),
    };
    expect(
      await walkPath(repo, livePath(a, ["b", "gone"]), { accounts, providers: async () => sub })
    ).toBeUndefined();
    b.change((d) => delete d.notes);
    expect(await walkPath(repo, livePath(a, ["b", "notes"]), { accounts, providers })).toBeUndefined();
  });

  it("lists a sub-document in the container's file list", async () => {
    const { repo, a, accounts } = await boardFixture();
    const end = await walkPath(repo, livePath(a, ["b"]), { accounts, providers });
    const listed = await listFiles(repo, end!.pinned, { accounts, providers });
    expect(listed?.files.map((f) => f.tail).sort()).toEqual(["", "child", "notes"]);
  });
});
