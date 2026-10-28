import { describe, it, expect } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { formatHeads, idhash, livePath, pinnedPath } from "@inkandswitch/patchwork-filesystem";
import { buildManifest } from "../src/manifest.js";
import { contentHash } from "@inkandswitch/patchwork-filesystem";

const file = (repo: Repo, content: string) =>
  repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" }).url;
const folder = (repo: Repo, entries: Record<string, AutomergeUrl>) =>
  repo.create({
    title: "folder",
    docs: Object.entries(entries).map(([name, url]) => ({ name, type: "x", url })),
  });

async function fixture() {
  const repo = new Repo();
  const projects = folder(repo, { note: file(repo, "héllo ✓") });
  const root = folder(repo, { Projects: projects.url });
  const pkg = repo.create({
    "@patchwork": { type: "directory" },
    "index.js": file(repo, "export default 1"),
  });
  const packages = folder(repo, { pkg: pkg.url });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }], "/packages": [{ url: packages.url }] },
  });
  const a = await idhash(account.documentId);
  return { repo, a, accounts: new Map([[a, account.url]]), projects };
}

describe("buildManifest", () => {
  it("hashes each file as the service worker will", async () => {
    const { repo, a, accounts } = await fixture();
    const prefix = await pinnedPath(repo, livePath(a, ["Projects"]), { accounts });
    const manifest = (await buildManifest(repo, prefix!, { accounts }))?.manifest;
    expect(manifest?.prefix).toBe(prefix);
    expect(manifest?.entries.note).toEqual({
      sha256: await contentHash(new TextEncoder().encode("héllo ✓")),
      contentType: "text/plain",
      store: true,
    });
  });

  it("stores protected content only through /packages", async () => {
    const { repo, a, accounts } = await fixture();
    const isProtected = () => true;
    const projects = await pinnedPath(repo, livePath(a, ["Projects"]), { accounts });
    const pkg = await pinnedPath(repo, livePath(a, ["packages", "pkg"]), { accounts });
    expect((await buildManifest(repo, projects!, { accounts, isProtected }))?.manifest.entries.note.store).toBe(false);
    expect((await buildManifest(repo, pkg!, { accounts, isProtected }))?.manifest.entries["index.js"].store).toBe(true);
  });

  it("never stores under a share root", async () => {
    const { repo, accounts, projects } = await fixture();
    const share = `automerge:${projects.documentId}@${formatHeads(projects.heads())}`;
    const built = await buildManifest(repo, share, { accounts });
    expect(built?.manifest.entries.note.store).toBe(false);
  });

  it("returns nothing for a live path", async () => {
    const { repo, a, accounts } = await fixture();
    expect(await buildManifest(repo, livePath(a, ["Projects"]), { accounts })).toBeUndefined();
  });
});
