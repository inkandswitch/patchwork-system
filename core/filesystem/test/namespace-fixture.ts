// A small account to walk: / is a folder of Projects, /packages a union of two folders.
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { docStep, idhash } from "../src/paths.js";
import { walkPath } from "../src/walk.js";

export const step = async (handle: DocHandle<unknown>) =>
  docStep(await idhash(handle.documentId), handle.heads());

export const folder = (repo: Repo, entries: Record<string, AutomergeUrl>) =>
  repo.create({
    title: "folder",
    docs: Object.entries(entries).map(([name, url]) => ({
      name,
      type: "x",
      url,
    })),
  });

export const file = (repo: Repo, content: string) =>
  repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" });

// A package the way pushwork writes one: a directory doc of path → file doc url.
export const pkg = (repo: Repo, main: string) =>
  repo.create({
    "@patchwork": { type: "directory" },
    "package.json": file(repo, "{}").url,
    "dist/index.js": file(repo, main).url,
  });

export async function fixture() {
  const repo = new Repo();
  const notes = file(repo, "hi");
  const foo = folder(repo, { notes: notes.url });
  const projects = folder(repo, { foo: foo.url });
  const decoy = folder(repo, { foo: file(repo, "decoy").url });
  const root = folder(repo, {
    Projects: projects.url,
    packages: decoy.url,
  });
  const minePkg = pkg(repo, "mine");
  const mine = folder(repo, { foo: minePkg.url });
  const team = folder(repo, {
    foo: pkg(repo, "team foo").url,
    bar: pkg(repo, "team bar").url,
  });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: {
      "/": [{ url: root.url }],
      "/packages": [{ url: mine.url }, { url: team.url }],
    },
  });
  const a = await idhash(account.documentId);
  const accounts = new Map([[a, account.url]]);
  return {
    repo, a, accounts, account, root, projects, foo, notes, mine, minePkg,
    team,
  };
}

export const text = (handle: DocHandle<any> | undefined) => handle?.doc()?.content;

/** A path's pinned form: what the walk writes. */
export const chain = async (
  repo: Repo,
  path: string,
  accounts: ReadonlyMap<string, AutomergeUrl>
) => (await walkPath(repo, path, { accounts }))?.pinned;
