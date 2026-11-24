import { describe, it, expect } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { docStep, idhash, livePath } from "../src/paths.js";
import { chain, file, fixture, step, text } from "./namespace-fixture.js";
import { resolveLivePath, walkPath } from "../src/walk.js";

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
    const pinned = await chain(repo, livePath(a, ["Projects", "foo"]), accounts);
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

  it("stops when / is bound to the account itself", async () => {
    const repo = new Repo();
    const account = repo.create<any>({ "@patchwork": { type: "account" } });
    account.change((d: any) => (d.namespace = { "/": [{ url: account.url }] }));
    const a = await idhash(account.documentId);
    expect(
      await resolveLivePath(repo, livePath(a, ["x"]), {
        accounts: new Map([[a, account.url]]),
      })
    ).toBeUndefined();
  });
});

describe("walkPath's pinned form", () => {
  it("pins every container the walk enters and keeps the tail as names", async () => {
    const { repo, a, accounts, account, mine, minePkg } = await fixture();
    const live = livePath(a, ["packages", "foo", "dist", "index.js"]);
    const pinned = await chain(repo, live, accounts);
    expect(pinned).toBe(
      `${docStep(a, account.heads())}/packages/${await step(mine)}/${await step(minePkg)}/dist/index.js`
    );
    expect(text(await resolveLivePath(repo, pinned!, { accounts }))).toBe("mine");
  });

  it("writes the / binding as a doc step with no name", async () => {
    const { repo, a, accounts, account, root, projects, foo } = await fixture();
    expect(await chain(repo, livePath(a, ["Projects", "foo"]), accounts)).toBe(
      [
        docStep(a, account.heads()),
        await step(root),
        await step(projects),
        await step(foo),
      ].join("/")
    );
  });

  it("re-pins a pinned path to the same string", async () => {
    const { repo, a, accounts } = await fixture();
    const pinned = await chain(
      repo,
      livePath(a, ["packages", "bar", "dist", "index.js"]),
      accounts
    );
    expect(await chain(repo, pinned!, accounts)).toBe(pinned);
  });

  it("says where a path ends inside a document", async () => {
    const { repo, a, accounts, minePkg } = await fixture();
    minePkg.change((d: any) => (d.nested = { x: "y" }));
    const end = await walkPath(repo, livePath(a, ["packages", "foo", "nested"]), {
      accounts,
    });
    expect(end?.atDocument).toBe(false);
    expect(end?.node).toEqual({ x: "y" });
    expect(end?.handle.documentId).toBe(minePkg.documentId);
  });

  it("starts at a share link", async () => {
    const { repo, foo, notes } = await fixture();
    const share = `automerge:${foo.documentId}@${foo.heads().join(".")}`;
    const handle = await resolveLivePath(repo, `${share}/notes`, {
      accounts: new Map(),
    });
    expect(handle?.url).toBe(notes.url);
  });
});
