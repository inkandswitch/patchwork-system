import { describe, it, expect, vi } from "vitest";
import { contentHash, toBytes } from "../src/content-hash.js";
import type { ContentStore } from "../src/content-store.js";
import {
  PinnedAbort,
  normalizePinned,
  servePinned,
  sharedManifests,
  type PinnedDeps,
} from "../src/pinned.js";
import type { IndexEntry, Manifest } from "../src/types.js";

const keysOf = (path: string) => normalizePinned(path)!.keys;

describe("normalizePinned", () => {
  it("gives every spelling of a file one key among its candidates", () => {
    const canonical = keysOf("acct@h/x@h/a%40b.js")[0];
    expect(canonical).toBe("acct@h/x@h/a%40b.js");
    for (const spelling of [
      "acct@h/x@h/a@b.js",
      "/acct@h//x@h/a%40b.js/",
      "acct@h/x@h/a%40b.js",
    ]) {
      expect(keysOf(spelling)).toContain(canonical);
    }
    expect(keysOf("acct@h/x@h/日本")).toEqual(
      keysOf("acct@h/x@h/%E6%97%A5%E6%9C%AC")
    );
  });

  it("tries the latest doc step first, then each earlier one", () => {
    expect(keysOf("acct@h/packages/m@h/f@h/vendor/react@18.3.1/index.js")).toEqual([
      "acct@h/packages/m@h/f@h/vendor/react@18.3.1/index.js",
      "acct@h/packages/m@h/f@h/vendor/react%4018.3.1/index.js",
      "acct@h/packages/m@h/f%40h/vendor/react%4018.3.1/index.js",
    ]);
  });

  it("splits the first key at its last doc step", () => {
    expect(normalizePinned("acct@h/packages/m@h/f@h/dist/index.js")).toMatchObject({
      prefix: "acct@h/packages/m@h/f@h",
      acctHash: "acct",
      pinned: true,
      share: false,
    });
  });

  it("says a live path is live", () => {
    expect(normalizePinned("acct/Projects")).toMatchObject({
      pinned: false,
      acctHash: "acct",
    });
  });

  it("reads a share root", () => {
    const n = normalizePinned("automerge%3A2j9knpCseyhnK8izDmLpGP5WMdZQ@h/x");
    expect(n).toMatchObject({ pinned: true, share: true, acctHash: undefined });
    expect(n!.keys[0]).toBe("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ@h/x");
  });

  it("refuses a malformed escape or a bad root", () => {
    expect(normalizePinned("acct@h/%zz")).toBeUndefined();
    expect(normalizePinned("")).toBeUndefined();
    expect(normalizePinned("not-base58!/x")).toBeUndefined();
  });
});

class MemoryStore implements ContentStore {
  bytes = new Map<string, Uint8Array>();
  async get(hash: string) {
    return this.bytes.get(hash);
  }
  async put(hash: string, bytes: Uint8Array) {
    this.bytes.set(hash, bytes);
  }
  async delete(hash: string) {
    this.bytes.delete(hash);
  }
}

const KEY = "acct@h/pkg@h/index.js";
const REAL = toBytes("export default 42");

async function setup(options: { store?: boolean; manifest?: boolean } = {}) {
  const sha256 = await contentHash(REAL);
  const entry: IndexEntry = {
    sha256,
    contentType: "text/javascript",
    store: options.store ?? true,
  };
  const manifest: Manifest = {
    prefix: "acct@h/pkg@h",
    entries: { "index.js": entry },
  };
  const kept: Promise<unknown>[] = [];
  const deps = {
    index: new Map<string, IndexEntry>(),
    store: new MemoryStore(),
    hash: contentHash,
    manifest: vi.fn(async () => (options.manifest === false ? undefined : manifest)),
    resolve: vi.fn(async () => ({ body: REAL, contentType: "text/javascript" })),
    warn: vi.fn(),
    keep: (work: Promise<unknown>) => void kept.push(work),
  } satisfies PinnedDeps;
  const settle = () => Promise.all(kept);
  return { deps, sha256, entry, manifest, settle };
}

const text = (response: Response) => response.text();

describe("servePinned", () => {
  it("serves a store hit whose bytes match, without asking a resolver", async () => {
    const { deps, sha256 } = await setup();
    await deps.store.put(sha256, REAL);
    const response = await servePinned([KEY], deps);
    expect(await text(response)).toBe("export default 42");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("deletes a forged store entry, warns, and serves the resolver's real bytes", async () => {
    const { deps, sha256, settle } = await setup();
    await deps.store.put(sha256, toBytes("export default 666"));
    const response = await servePinned([KEY], deps);
    await settle();
    expect(await text(response)).toBe("export default 42");
    expect(deps.warn).toHaveBeenCalled();
    expect(deps.store.bytes.get(sha256)).toEqual(REAL);
  });

  it("asks for one manifest on an index miss, then serves", async () => {
    const { deps } = await setup();
    await servePinned([KEY], deps);
    await servePinned([KEY], deps);
    expect(deps.manifest).toHaveBeenCalledTimes(1);
  });

  it("finds the entry under a later candidate key", async () => {
    const { deps } = await setup();
    const response = await servePinned(["acct@h/pkg@h/index@x.js", KEY], deps);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("stores resolver bytes that match an entry that allows it", async () => {
    const { deps, sha256, settle } = await setup();
    await servePinned([KEY], deps);
    await settle();
    expect(deps.store.bytes.get(sha256)).toEqual(REAL);
  });

  it("never stores when the entry says not to", async () => {
    const { deps, settle } = await setup({ store: false });
    expect(await text(await servePinned([KEY], deps))).toBe("export default 42");
    await settle();
    expect(deps.store.bytes.size).toBe(0);
  });

  it("fails as a network error when resolver bytes don't match, storing nothing", async () => {
    const { deps, settle } = await setup();
    deps.resolve.mockResolvedValue({
      body: toBytes("export default 666"),
      contentType: "text/javascript",
    });
    await expect(servePinned([KEY], deps)).rejects.toBeInstanceOf(PinnedAbort);
    await settle();
    expect(deps.store.bytes.size).toBe(0);
  });

  it("serves inline and stores nothing with no manifest", async () => {
    const { deps, settle } = await setup({ manifest: false });
    const response = await servePinned([KEY], deps);
    await settle();
    expect(await text(response)).toBe("export default 42");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.store.bytes.size).toBe(0);
    expect(deps.index.size).toBe(0);
  });

  it("answers 404 when nothing resolves the path", async () => {
    const { deps } = await setup({ manifest: false });
    deps.resolve.mockResolvedValue(undefined as never);
    expect((await servePinned([KEY], deps)).status).toBe(404);
  });

  it("rebuilds the index after a restart and reuses the store", async () => {
    const first = await setup();
    await servePinned([KEY], first.deps);
    await first.settle();
    const second = await setup();
    second.deps.store = first.deps.store;
    expect(await text(await servePinned([KEY], second.deps))).toBe("export default 42");
    expect(second.deps.manifest).toHaveBeenCalledTimes(1);
    expect(second.deps.resolve).not.toHaveBeenCalled();
  });

  it("reads and writes nothing without a store", async () => {
    const { deps } = await setup();
    const response = await servePinned([KEY], { ...deps, store: undefined });
    expect(await text(response)).toBe("export default 42");
  });
});

describe("sharedManifests", () => {
  it("shares one manifest request among concurrent requests for a package", async () => {
    const { deps, manifest } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetcher = vi.fn(async () => (await gate, manifest));
    const shared = sharedManifests(fetcher, (key) => normalizePinned(key)!.prefix);
    const all = ["a.js", "b.js", "c.js", "d.js", "index.js"].map((file) =>
      shared(`acct@h/pkg@h/${file}`)
    );
    release();
    await Promise.all(all);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // settled requests aren't remembered: the next asks again
    await shared(KEY);
    expect(fetcher).toHaveBeenCalledTimes(2);
    void deps;
  });
});
