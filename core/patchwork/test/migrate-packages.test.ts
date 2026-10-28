import { describe, expect, it } from "vitest";
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { migratePackages } from "../src/migrate-packages.js";
import { createDefaultAccount } from "../src/createAccount.js";

async function account(repo: Repo, modules: string[]) {
  const settings = repo.create({ "@patchwork": { type: "patchwork:module-settings" }, modules });
  const acct = repo.create<any>({
    "@patchwork": { type: "account" },
    moduleSettingsUrl: settings.url,
  });
  return acct as DocHandle<any>;
}

function packages(repo: Repo) {
  const file = (content: string) =>
    repo.create({ "@patchwork": { type: "file" }, content, mimeType: "application/json" }).url;
  const alpha = repo.create({
    "@patchwork": { type: "directory" },
    "package.json": file('{"name":"alpha","main":"index.js"}'),
  });
  const bee = repo.create({ "@patchwork": { type: "folder" }, title: "Bee", docs: [] });
  return { alpha, bee };
}

const linked = async (repo: Repo, acct: DocHandle<any>) => {
  const binding = acct.doc().namespace?.["/packages"];
  if (!binding) return undefined;
  const folder = await repo.find<any>(binding[0].url as AutomergeUrl);
  return folder.doc().docs.map((d: any) => [d.name, d.url]);
};

describe("migratePackages", () => {
  it("links each automerge entry by its package.json name, and binds /packages", async () => {
    const repo = new Repo();
    const { alpha, bee } = packages(repo);
    const acct = await account(repo, [
      alpha.url,
      bee.url,
      "https://cdn.example.test/tool/index.js",
    ]);
    expect(await migratePackages(repo, acct)).toBe(true);
    expect(await linked(repo, acct)).toEqual([
      ["alpha", alpha.url],
      ["Bee", bee.url],
    ]);
  });

  it("does nothing the second time", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    await migratePackages(repo, acct);
    const bound = acct.doc().namespace["/packages"][0].url;
    expect(await migratePackages(repo, acct)).toBe(false);
    expect(acct.doc().namespace["/packages"][0].url).toBe(bound);
  });

  it("leaves an account that already binds /packages alone", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    const existing = repo.create({ title: "mine", docs: [] }).url;
    acct.change((d: any) => (d.namespace = { "/packages": [{ url: existing }] }));
    expect(await migratePackages(repo, acct)).toBe(false);
    expect(acct.doc().namespace["/packages"]).toEqual([{ url: existing }]);
  });

  it("does nothing for an account without module settings", async () => {
    const repo = new Repo();
    const acct = repo.create<any>({ "@patchwork": { type: "account" } });
    expect(await migratePackages(repo, acct as DocHandle<any>)).toBe(false);
  });
});

describe("migratePackages: what it can't simply link", () => {
  it("names two packages with one package.json name apart", async () => {
    const repo = new Repo();
    const twin = () => {
      const json = repo.create({ "@patchwork": { type: "file" }, content: '{"name":"alpha"}', mimeType: "application/json" });
      return repo.create({ "@patchwork": { type: "directory" }, "package.json": json.url });
    };
    const [a, b] = [twin(), twin()];
    const acct = await account(repo, [a.url, b.url]);
    await migratePackages(repo, acct);
    expect(await linked(repo, acct)).toEqual([
      ["alpha", a.url],
      ["alpha (2)", b.url],
    ]);
  });

  it("links a package it can't read under its document id", async () => {
    const repo = new Repo();
    const missing = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl;
    const acct = await account(repo, [missing]);
    await migratePackages(repo, acct, { readTimeoutMs: 200 });
    expect(await linked(repo, acct)).toEqual([["4NMNnkMhL8jXrdJ9jamS58PAVdXu", missing]]);
  });

  it("leaves an entry pinned to heads in module settings", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.view(alpha.heads()).url]);
    await migratePackages(repo, acct);
    expect(await linked(repo, acct)).toEqual([]);
  });

  it("waits for the account to catch up, and leaves it for next boot if it can't", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    expect(await migratePackages(repo, acct, { caughtUp: async () => false })).toBe(false);
    expect(acct.doc().namespace).toBeUndefined();
  });

  it("doesn't migrate again after /packages was emptied on purpose", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    acct.change((d: any) => (d.namespace = { "/packages": [] }));
    expect(await migratePackages(repo, acct)).toBe(false);
  });
});

describe("migratePackages: the packages folder in the tree", () => {
  it("links the new folder into the root folder as packages", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    const root = repo.create<any>({ title: "root", docs: [] });
    acct.change((d: any) => (d.rootFolderUrl = root.url));
    await migratePackages(repo, acct);
    expect(root.doc().docs).toEqual([
      { name: "packages", type: "folder", url: acct.doc().namespace["/packages"][0].url },
    ]);
  });

  it("leaves a root folder that already has something named packages alone", async () => {
    const repo = new Repo();
    const { alpha } = packages(repo);
    const acct = await account(repo, [alpha.url]);
    const mine = repo.create({ title: "mine", docs: [] }).url;
    const root = repo.create<any>({ title: "root", docs: [{ name: "packages", type: "folder", url: mine }] });
    acct.change((d: any) => (d.rootFolderUrl = root.url));
    await migratePackages(repo, acct);
    expect(root.doc().docs).toHaveLength(1);
    expect(root.doc().docs[0].url).toBe(mine);
  });
});

describe("createDefaultAccount", () => {
  it("binds / to the root folder and /packages to a new one", async () => {
    const repo = new Repo();
    const acct = repo.create<any>({ "@patchwork": { type: "account" } });
    await createDefaultAccount(acct as DocHandle<any>, repo as any);
    const doc = acct.doc();
    expect(doc.namespace["/"]).toEqual([{ url: doc.rootFolderUrl }]);
    const packagesFolder = await repo.find<any>(doc.namespace["/packages"][0].url);
    expect(packagesFolder.doc()).toMatchObject({ title: "Packages", docs: [] });
    const root = await repo.find<any>(doc.rootFolderUrl);
    expect(root.doc().docs).toEqual([
      { name: "packages", type: "folder", url: packagesFolder.url },
    ]);
    expect(doc.moduleSettingsUrl).toBeDefined();
  });
});
