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

describe("watchPackagesFolder: duplicate names", () => {
  it("skips, and warns about, a second package with one name in one member", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new Repo();
    const pkg = () => repo.create({ "@patchwork": { type: "directory" } }).url;
    const [a, b] = [pkg(), pkg()];
    const mine = folder(repo, [["same", a], ["same", b]]);
    const account = repo.create<any>({
      "@patchwork": { type: "account" },
      namespace: { "/packages": [{ url: mine.url }] },
    });
    const seen: PackageEntry[][] = [];
    const stop = watchPackagesFolder(repo, account, (entries) => seen.push(entries));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0].map((e) => e.url)).toEqual([a]);
    expect(warn).toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });
});

describe("trackPackagesFolder: stable URLs", () => {
  it("keeps a package's URL while its own step is unchanged", async () => {
    const entry = { url: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ" as AutomergeUrl, name: "foo", memberStep: "m@h1" };
    const fallback: PackageTracker = { findLatest: vi.fn(), watch: vi.fn(() => () => {}) };
    let root = "acct@r1";
    const lookUp = vi.fn(async () => `https://p.test/@/${root}/packages/m@h1/pkg@p1~L1`);
    const tracker = trackPackagesFolder(Promise.resolve("acct"), () => [entry], fallback, lookUp);
    const first = await tracker.findLatest(entry.url);
    // the account and the member moved; the package didn't
    root = "acct@r2";
    expect(await tracker.findLatest(entry.url)).toBe(first);
    lookUp.mockResolvedValue("https://p.test/@/acct@r2/packages/m@h1/pkg@p2~L2");
    expect(await tracker.findLatest(entry.url)).toBe("https://p.test/@/acct@r2/packages/m@h1/pkg@p2~L2");
  });
});

describe("trackPackagesFolder: a branches package", () => {
  it("watches the branch it stands for, and follows the branch when it moves", async () => {
    const BRANCHES = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ" as AutomergeUrl;
    const MAIN = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl;
    const NEXT = "automerge:3tmVsDzywTYecevUsD21YABfXKon" as AutomergeUrl;
    const entry = { url: BRANCHES, name: "foo", memberStep: "m@h" };
    let current = MAIN;
    const watchers = new Map<string, Set<(seen?: string) => void>>();
    const fire = (url: string) => watchers.get(url)?.forEach((cb) => cb());
    const fallback: PackageTracker = {
      findLatest: vi.fn(async (url) => (url === BRANCHES ? current : url)),
      watch: vi.fn((url, onChange) => {
        if (!watchers.has(url)) watchers.set(url, new Set());
        watchers.get(url)!.add(onChange);
        return () => watchers.get(url)!.delete(onChange);
      }),
    };
    const tracker = trackPackagesFolder(Promise.resolve("acct"), () => [entry], fallback, vi.fn());
    const changes = vi.fn();
    const stop = tracker.watch(BRANCHES, changes);

    // New code on the default branch, with the branch pointer unchanged.
    await vi.waitFor(() => expect(watchers.get(MAIN)?.size).toBe(1));
    fire(MAIN);
    expect(changes).toHaveBeenCalledTimes(1);

    // The branch moves: the watch follows it.
    current = NEXT;
    fire(BRANCHES);
    await vi.waitFor(() => expect(watchers.get(NEXT)?.size).toBe(1));
    expect(watchers.get(MAIN)?.size).toBe(0);

    stop();
    expect(watchers.get(NEXT)?.size).toBe(0);
    expect(watchers.get(BRANCHES)?.size).toBe(0);
  });
});

describe("watchPackagesFolder: a member that can't be found yet", () => {
  it("lists the members it has, and the slow one once it arrives", async () => {
    const { repo, p1, p2, p3, mine, team, account } = await fixture();
    let release: (() => void) | undefined;
    const find = repo.find.bind(repo);
    (repo as any).find = (url: AutomergeUrl, ...rest: any[]) =>
      url === mine.url
        ? new Promise((resolve) => (release = () => resolve(find(url, ...rest))))
        : find(url, ...rest);
    const seen: PackageEntry[][] = [];
    const stop = watchPackagesFolder(repo, account, (entries) => seen.push(entries), {
      patienceMs: 100,
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)!.map((e) => e.url).sort()).toEqual([p3, p2].sort());
    release!();
    await vi.waitFor(() => expect(seen.at(-1)!.map((e) => e.url)).toEqual([p1, p2, p3]));
    stop();
    expect(team).toBeDefined();
  });
});
