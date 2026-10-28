import { describe, it, expect, vi } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { docStep, idhash } from "../src/paths.js";
import {
  packageLookupPath,
  trackPackagesFolder,
  watchPackagesFolder,
  type PackageEntry,
} from "../src/packages-folder.js";
import type { PackageTracker } from "../src/package-tracker.js";

const folder = (repo: Repo, entries: Array<[string, AutomergeUrl]>) =>
  repo.create({
    title: "packages",
    docs: entries.map(([name, url]) => ({ name, type: "x", url })),
  });

async function fixture() {
  const repo = new Repo();
  const pkg = () => repo.create({ "@patchwork": { type: "directory" } }).url;
  const [p1, p2, p3] = [pkg(), pkg(), pkg()];
  const mine = folder(repo, [["foo", p1], ["bar", p2]]);
  const team = folder(repo, [["foo", p3], ["bar", p2]]);
  const account = repo.create<any>({
    "@patchwork": { type: "account" },
    namespace: { "/packages": [{ url: mine.url }, { url: team.url }] },
  });
  return { repo, p1, p2, p3, mine, team, account };
}

describe("watchPackagesFolder", () => {
  it("lists every package in the union, once per document, first binding first", async () => {
    const { repo, p1, p2, p3, mine, team, account } = await fixture();
    const seen: PackageEntry[][] = [];
    const stop = watchPackagesFolder(repo, account, (entries) => seen.push(entries));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const entries = seen.at(-1)!;
    expect(entries.map((e) => [e.name, e.url])).toEqual([
      ["foo", p1],
      ["bar", p2],
      ["foo", p3],
    ]);
    expect(entries[0].memberStep).toBe(docStep(await idhash(mine.documentId), mine.heads()));
    expect(entries[2].memberStep).toBe(docStep(await idhash(team.documentId), team.heads()));
    stop();
  });

  it("tells again when a member folder gains a package", async () => {
    const { repo, mine, account } = await fixture();
    const seen: PackageEntry[][] = [];
    const stop = watchPackagesFolder(repo, account, (entries) => seen.push(entries));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    const added = repo.create({ "@patchwork": { type: "directory" } }).url;
    mine.change((d: any) => d.docs.push({ name: "new", type: "x", url: added }));
    await vi.waitFor(() => expect(seen.at(-1)!.map((e) => e.url)).toContain(added));
    stop();
  });

  it("tells nothing for an account with no /packages", async () => {
    const repo = new Repo();
    const account = repo.create<any>({ "@patchwork": { type: "account" } });
    const seen: PackageEntry[][] = [];
    const stop = watchPackagesFolder(repo, account, (entries) => seen.push(entries));
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    stop();
  });
});

describe("packageLookupPath", () => {
  it("goes through the member that holds the package", () => {
    const entry = { url: "automerge:x" as AutomergeUrl, name: "my pkg", memberStep: "m@h" };
    expect(packageLookupPath("acct", entry)).toBe("acct/packages/m@h/my%20pkg");
  });
});

describe("trackPackagesFolder", () => {
  it("looks a /packages package up through /@/, and anything else through the fallback", async () => {
    const entry = { url: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ" as AutomergeUrl, name: "foo", memberStep: "m@h" };
    const fallback: PackageTracker = {
      findLatest: vi.fn(async (url) => `${url}#heads` as AutomergeUrl),
      watch: vi.fn(() => () => {}),
    };
    const lookUp = vi.fn(async (path: string) => `https://p.test/@/${path}~L`);
    const tracker = trackPackagesFolder(Promise.resolve("acct"), () => [entry], fallback, lookUp);

    expect(await tracker.findLatest(entry.url)).toBe("https://p.test/@/acct/packages/m@h/foo~L");
    const other = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl;
    expect(await tracker.findLatest(other)).toBe(`${other}#heads`);
    tracker.watch(entry.url, () => {});
    expect(fallback.watch).toHaveBeenCalled();
  });
});
