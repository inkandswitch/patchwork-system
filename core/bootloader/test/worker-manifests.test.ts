import { describe, it, expect, vi } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { idhash, livePath, pinnedPath } from "@inkandswitch/patchwork-filesystem";
import { createManifestHandler } from "../src/manifest.js";
import type { IndexAnswer } from "../src/types.js";

const file = (repo: Repo, content: string) =>
  repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" }).url;

async function fixture(packages = 1) {
  const repo = new Repo();
  const pkgs = Array.from({ length: packages }, (_, i) =>
    repo.create({
      "@patchwork": { type: "directory" },
      "a.js": file(repo, `a${i}`),
      "b.js": file(repo, `b${i}`),
    })
  );
  const folder = repo.create({
    title: "packages",
    docs: pkgs.map((pkg, i) => ({ name: `p${i}`, type: "x", url: pkg.url })),
  });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/packages": [{ url: folder.url as AutomergeUrl }] },
  });
  const a = await idhash(account.documentId);
  const accounts = new Map([[a, account.url]]);
  const prefixes = await Promise.all(
    pkgs.map((_, i) => pinnedPath(repo, livePath(a, ["packages", `p${i}`]), { accounts }))
  );
  return { repo, accounts, pkgs, prefixes: prefixes as string[] };
}

const setup = async (packages?: number, unreadable?: (url: string) => boolean) => {
  const f = await fixture(packages);
  const posted: IndexAnswer[] = [];
  const post = vi.fn(async (answer: IndexAnswer) => (posted.push(answer), true));
  const finds: string[] = [];
  const find = (repo: Repo) => (url: AutomergeUrl) => {
    finds.push(url);
    return unreadable?.(url) ? Promise.reject(new Error("unavailable")) : repo.find(url);
  };
  const handle = createManifestHandler(() => Promise.resolve(f.repo), () => f.accounts, {
    post,
    find,
  });
  return { ...f, handle, posted, finds };
};

describe("createManifestHandler", () => {
  it("builds a package's manifest once and answers every file's request with it", async () => {
    const { handle, prefixes, posted, finds } = await setup();
    await Promise.all([
      handle({ type: "manifest", id: "1", path: `${prefixes[0]}/a.js` }),
      handle({ type: "manifest", id: "2", path: `${prefixes[0]}/b.js` }),
    ]);
    await handle({ type: "manifest", id: "3", path: `${prefixes[0]}/a.js` });
    expect(posted.map((p) => p.id).sort()).toEqual(["1", "2", "3"]);
    expect(posted[0].manifest).toEqual(posted[1].manifest);
    expect(Object.keys(posted[0].manifest!.entries).sort()).toEqual(["", "a.js", "b.js"]);
    // a request for a package already built walks to it and lists nothing again
    const fileFinds = finds.length;
    await handle({ type: "manifest", id: "4", path: `${prefixes[0]}/b.js` });
    expect(finds.length - fileFinds).toBeLessThanOrEqual(4); // a walk, no relisting
  });

  it("echoes the path it answers for", async () => {
    const { handle, prefixes, posted } = await setup();
    await handle({ type: "manifest", id: "1", path: `${prefixes[0]}/a.js` });
    expect(posted[0].path).toBe(`${prefixes[0]}/a.js`);
  });

  it("doesn't remember a manifest that's missing files", async () => {
    let bUrl = "";
    const { handle, prefixes, posted, finds, pkgs } = await setup(1, (url) => url === bUrl);
    bUrl = String((pkgs[0].doc() as Record<string, unknown>)["b.js"]);
    await handle({ type: "manifest", id: "1", path: prefixes[0] });
    expect(Object.keys(posted[0].manifest!.entries)).not.toContain("b.js");
    await handle({ type: "manifest", id: "2", path: prefixes[0] });
    expect(finds.filter((url) => url === bUrl)).toHaveLength(2);
  });

  it("posts an error for a path it can't list", async () => {
    const { handle, posted } = await setup();
    await handle({ type: "manifest", id: "x", path: "unknown@h/a.js" });
    expect(posted[0]).toMatchObject({ id: "x", error: expect.any(String) });
    expect(posted[0].manifest).toBeUndefined();
  });

  it("evicts the oldest manifest after 64", async () => {
    const { handle, prefixes, posted, finds } = await setup(65);
    for (const [i, prefix] of prefixes.entries()) {
      await handle({ type: "manifest", id: `${i}`, path: prefix });
    }
    const before = finds.length;
    await handle({ type: "manifest", id: "again", path: prefixes[64] });
    const cached = finds.length - before;
    await handle({ type: "manifest", id: "evicted", path: prefixes[0] });
    const rebuilt = finds.length - before - cached;
    expect(rebuilt).toBeGreaterThan(cached);
    expect(posted.at(-1)?.manifest?.prefix).toBe(prefixes[0]);
  });
});
