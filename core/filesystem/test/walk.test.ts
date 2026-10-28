import { describe, it, expect, vi, afterEach } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { docStep, idhash, livePath } from "../src/paths.js";
import { file, fixture, step, text } from "./namespace-fixture.js";
import {
  listChildren,
  listUnion,
  pinnedPath,
  pinPath,
  resolveLivePath,
  walkPath,
} from "../src/walk.js";

afterEach(() => vi.unstubAllGlobals());

describe("resolveLivePath", () => {
  it("resolves a live path through / and returns the live handle", async () => {
    const { repo, a, accounts, notes } = await fixture();
    const handle = await resolveLivePath(
      repo,
      livePath(a, ["Projects", "foo", "notes"]),
      { accounts }
    );
    expect(handle?.url).toBe(notes.url);
  });

  it("union: the first binding with the name wins", async () => {
    const { repo, a, accounts, minePkg, team } = await fixture();
    const foo = await resolveLivePath(repo, livePath(a, ["packages", "foo"]), { accounts });
    expect(foo?.url).toBe(minePkg.url);
    const bar = await resolveLivePath(repo, livePath(a, ["packages", "bar"]), { accounts });
    expect(bar?.url).toBe(team.doc().docs[1].url);
  });

  it("a mount shadows a same-named entry in /'s folder", async () => {
    const { repo, a, accounts } = await fixture();
    const index = await resolveLivePath(
      repo,
      livePath(a, ["packages", "foo", "dist", "index.js"]),
      { accounts }
    );
    expect(text(index)).toBe("mine");
  });

  it("a pinned path keeps resolving to the same version after a rename", async () => {
    const { repo, a, accounts, projects, foo } = await fixture();
    const pinned = await pinnedPath(repo, livePath(a, ["Projects", "foo"]), { accounts });
    const before = foo.heads();

    projects.change((d: any) => (d.docs[0].name = "bar"));
    foo.change((d: any) => (d.title = "renamed"));

    const old = await resolveLivePath(repo, pinned!, { accounts });
    expect(old?.documentId).toBe(foo.documentId);
    expect(old?.heads()).toEqual(before);
    expect((old?.doc() as any).title).toBe("folder");

    expect(
      await resolveLivePath(repo, livePath(a, ["Projects", "foo"]), { accounts })
    ).toBeUndefined();
    const bar = await resolveLivePath(repo, livePath(a, ["Projects", "bar"]), { accounts });
    expect(bar?.url).toBe(foo.url);
  });

  it("resolves a name that looks like a doc step but matches no link", async () => {
    const { repo, a, accounts, projects } = await fixture();
    const lookalike = `${await idhash("someOtherDocumentId")}@h1`;
    const target = file(repo, "lookalike");
    projects.change((d: any) =>
      d.docs.push({ name: lookalike, type: "x", url: target.url })
    );
    const handle = await resolveLivePath(repo, `${a}/Projects/${lookalike}`, { accounts });
    expect(handle?.url).toBe(target.url);
  });

  it("resolves a name with reserved characters", async () => {
    const { repo, a, accounts, projects } = await fixture();
    const name = "a/b c@%日本";
    const target = file(repo, "reserved");
    projects.change((d: any) => d.docs.push({ name, type: "x", url: target.url }));
    const handle = await resolveLivePath(repo, livePath(a, ["Projects", name]), { accounts });
    expect(handle?.url).toBe(target.url);
  });

  it("returns undefined for an unknown account, missing names, and heads the repo doesn't have", async () => {
    const { repo, a, accounts } = await fixture();
    expect(
      await resolveLivePath(repo, livePath("unknown", ["Projects"]), { accounts })
    ).toBeUndefined();
    expect(
      await resolveLivePath(repo, livePath(a, ["Projects", "nope"]), { accounts })
    ).toBeUndefined();
    expect(
      await resolveLivePath(repo, livePath(a, ["Projects", "foo", "notes", "deeper"]), { accounts })
    ).toBeUndefined();
    expect(
      await resolveLivePath(repo, `${a}@3vQB7B6MrGQZaxCuFg4oh/Projects`, { accounts })
    ).toBeUndefined();
  });

  it("reaches a directory key whose later segments look like doc steps", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    const vendored = file(repo, "react");
    minePkg.change((d: any) => (d["vendor/react@18.3.1/index.js"] = vendored.url));
    const handle = await resolveLivePath(
      repo,
      `${a}/packages/foo/vendor/react@18.3.1/index.js`,
      { accounts }
    );
    expect(handle?.url).toBe(vendored.url);
  });

  it("skips a null folder entry", async () => {
    const { repo, a, accounts, projects, foo } = await fixture();
    projects.change((d: any) => d.docs.unshift(null));
    const handle = await resolveLivePath(repo, livePath(a, ["Projects", "foo"]), { accounts });
    expect(handle?.url).toBe(foo.url);
  });

  it("treats a pinned root followed by live steps as live, not pinned", async () => {
    const { repo, a, accounts, account, foo } = await fixture();
    const mixed = `${docStep(a, account.heads())}/Projects/foo`;
    const end = await walkPath(repo, mixed, { accounts });
    expect(end?.canonical).toBe(false);
    // a live path's answer: the live handle, not a view whose heads look pinned
    expect((await resolveLivePath(repo, mixed, { accounts }))?.url).toBe(foo.url);

    const canonical = await walkPath(repo, end!.pinned, { accounts });
    expect(canonical?.canonical).toBe(true);
  });

  it("walks through the find it's given", async () => {
    const { repo, a, accounts } = await fixture();
    const seen: string[] = [];
    const find = (url: AutomergeUrl) => (seen.push(url), repo.find(url));
    const handle = await resolveLivePath(repo, livePath(a, ["Projects", "foo"]), {
      accounts,
      find,
    });
    expect(handle).toBeDefined();
    // the account, /, Projects, foo
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  it("fails, not throws, when find rejects", async () => {
    const { repo, a, accounts } = await fixture();
    const find = () => Promise.reject(new Error("offline"));
    expect(
      await resolveLivePath(repo, livePath(a, ["Projects"]), { accounts, find })
    ).toBeUndefined();
  });

  it("returns undefined for a path that ends inside a document", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => (d.nested = { x: "y" }));
    expect(
      await resolveLivePath(repo, livePath(a, ["packages", "foo", "nested"]), { accounts })
    ).toBeUndefined();
  });

  it("stops on a branches doc whose default is itself", async () => {
    const { repo, a, accounts } = await fixture();
    expect(
      await resolveLivePath(repo, livePath(a, ["loop", "x"]), { accounts })
    ).toBeUndefined();
    expect(
      await resolveLivePath(repo, livePath(a, ["loop"]), { accounts })
    ).toBeUndefined();
  });

  it("stops when / is bound to the account itself", async () => {
    const repo = new Repo();
    const account = repo.create<any>({ "@patchwork": { type: "account" } });
    account.change((d) => (d.namespace = { "/": [{ url: account.url }] }));
    const a = await idhash(account.documentId);
    expect(
      await resolveLivePath(repo, livePath(a, ["x"]), {
        accounts: new Map([[a, account.url]]),
      })
    ).toBeUndefined();
  });
});

describe("pinnedPath", () => {
  it("pins every container the walk enters, and keeps the tail after the last one as names", async () => {
    const { repo, a, accounts, account, mine, minePkg } = await fixture();
    const pinned = await pinnedPath(
      repo,
      livePath(a, ["packages", "foo", "dist", "index.js"]),
      { accounts }
    );
    expect(pinned).toBe(
      `${docStep(a, account.heads())}/packages/${await step(mine)}/${await step(minePkg)}/dist/index.js`
    );
    const index = await resolveLivePath(repo, pinned!, { accounts });
    expect(text(index)).toBe("mine");
  });

  it("writes the / binding as a doc step with no name", async () => {
    const { repo, a, accounts, account, root, projects, foo } = await fixture();
    expect(
      await pinnedPath(repo, livePath(a, ["Projects", "foo"]), { accounts })
    ).toBe(
      [docStep(a, account.heads()), await step(root), await step(projects), await step(foo)].join("/")
    );
  });

  it("walks into a branches doc and follows its default", async () => {
    const { repo, a, accounts, account, team, branchy, branchyPkg } = await fixture();
    const pinned = await pinnedPath(
      repo,
      livePath(a, ["packages", "branchy", "dist", "index.js"]),
      { accounts }
    );
    expect(pinned).toBe(
      `${docStep(a, account.heads())}/packages/${await step(team)}/${await step(branchy)}/${await step(branchyPkg)}/dist/index.js`
    );
    expect(text(await resolveLivePath(repo, pinned!, { accounts }))).toBe("branchy");
    // a path that ends at a branches doc stands for its default branch
    const end = await resolveLivePath(repo, livePath(a, ["packages", "branchy"]), { accounts });
    expect(end?.url).toBe(branchyPkg.url);
  });

  it("re-pins a pinned path to the same string", async () => {
    const { repo, a, accounts } = await fixture();
    const pinned = await pinnedPath(
      repo,
      livePath(a, ["packages", "bar", "dist", "index.js"]),
      { accounts }
    );
    expect(await pinnedPath(repo, pinned!, { accounts })).toBe(pinned);
  });
});

describe("pinPath", () => {
  it("prefixes the origin and /@/", async () => {
    vi.stubGlobal("location", { origin: "https://patchwork.test" });
    const { repo, a, accounts } = await fixture();
    const pinned = await pinnedPath(repo, livePath(a, ["Projects"]), { accounts });
    expect(await pinPath(repo, livePath(a, ["Projects"]), { accounts })).toBe(
      `https://patchwork.test/@/${pinned}`
    );
  });
});

describe("listing", () => {
  it("lists an account's children: mounts shadow / entries", async () => {
    const { repo, account } = await fixture();
    const names = (await listChildren(repo, account)).map((c) => c.name);
    expect(names.filter((n) => n === "packages")).toHaveLength(1);
    expect(names).toContain("Projects");
  });

  it("concatenates a union's bindings without deduplicating", async () => {
    const { repo, mine, team } = await fixture();
    const names = (await listUnion(repo, [mine.url, team.url])).map((c) => c.name);
    expect(names).toEqual(["foo", "foo", "bar", "branchy"]);
  });
});
