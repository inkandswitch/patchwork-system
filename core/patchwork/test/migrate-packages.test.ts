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
      alpha.view(alpha.heads()).url,
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

describe("createDefaultAccount", () => {
  it("binds / to the root folder and /packages to a new one", async () => {
    const repo = new Repo();
    const acct = repo.create<any>({ "@patchwork": { type: "account" } });
    await createDefaultAccount(acct as DocHandle<any>, repo as any);
    const doc = acct.doc();
    expect(doc.namespace["/"]).toEqual([{ url: doc.rootFolderUrl }]);
    const packagesFolder = await repo.find<any>(doc.namespace["/packages"][0].url);
    expect(packagesFolder.doc()).toMatchObject({ title: "Packages", docs: [] });
    expect(doc.moduleSettingsUrl).toBeDefined();
  });
});
