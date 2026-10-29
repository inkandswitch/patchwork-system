import { describe, it, expect, vi } from "vitest";
import {
  canonicalJson,
  contentHash,
  toBytes,
  type FileList,
} from "@inkandswitch/patchwork-filesystem";
import type { ContentStore } from "../src/content-store.js";
import {
  PinnedAbort,
  handoffRequest,
  keepFileList,
  normalizePinned,
  servePinned,
  sharedRequests,
  type PinnedDeps,
} from "../src/pinned.js";

const candidatesOf = (path: string) => normalizePinned(path)!.candidates;

describe("normalizePinned", () => {
  it("gives every spelling of a file one candidate", () => {
    const [canonical] = candidatesOf("acct@h/x@h~L/a%40b.js");
    expect(canonical).toEqual({ prefix: "acct@h/x@h", tail: "a%40b.js", listHash: "L" });
    for (const spelling of ["acct@h/x@h~L/a@b.js", "/acct@h//x@h~L/a%40b.js/"]) {
      expect(candidatesOf(spelling)).toContainEqual(canonical);
    }
    expect(candidatesOf("acct@h/x@h~L/日本")).toEqual(candidatesOf("acct@h/x@h~L/%E6%97%A5%E6%9C%AC"));
  });

  it("tries the latest doc step first, then each earlier one", () => {
    expect(candidatesOf("acct@h/packages/m@h/f@h~L/vendor/react@18.3.1/index.js")).toEqual([
      { prefix: "acct@h/packages/m@h/f@h~L/vendor/react@18.3.1", tail: "index.js" },
      { prefix: "acct@h/packages/m@h/f@h", tail: "vendor/react%4018.3.1/index.js", listHash: "L" },
      { prefix: "acct@h/packages/m@h", tail: "f%40h~L/vendor/react%4018.3.1/index.js" },
    ]);
  });

  it("says a live path is live", () => {
    expect(normalizePinned("acct/Projects")).toMatchObject({ pinned: false, acctHash: "acct" });
  });

  it("reads a share root, and a doc-step-shaped name under it", () => {
    const id = "2j9knpCseyhnK8izDmLpGP5WMdZQ";
    const n = normalizePinned(`automerge%3A${id}@h~L/react@18.3.1/x.js`)!;
    expect(n).toMatchObject({ pinned: true, share: true, acctHash: undefined });
    expect(n.candidates).toContainEqual({
      prefix: `automerge:${id}@h`,
      tail: "react%4018.3.1/x.js",
      listHash: "L",
    });
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

const REAL = toBytes("export default 42");
const FORGED = toBytes("export default 666");

async function setup(options: { store?: boolean } = {}) {
  const sha256 = await contentHash(REAL);
  const list: FileList = {
    v: 1,
    files: {
      "index.js": { sha256, type: "text/javascript", heads: "fh", store: options.store ?? true },
    },
  };
  const listBytes = new TextEncoder().encode(canonicalJson(list));
  const listHash = await contentHash(listBytes);
  const path = `acct@h/pkg@h~${listHash}/index.js`;
  const kept: Promise<unknown>[] = [];
  const deps = {
    lists: new Map<string, FileList>(),
    store: new MemoryStore(),
    hash: contentHash,
    buildList: vi.fn(
      async (_prefix: string, _only?: string) => listBytes as Uint8Array | undefined
    ),
    resolve: vi.fn(async (_path: string, _heads?: string) => ({
      body: REAL,
      contentType: "text/javascript",
    }) as { body: Uint8Array; contentType: string } | Response | undefined),
    warn: vi.fn(),
    keep: (work: Promise<unknown>) => void kept.push(work),
  } satisfies PinnedDeps;
  return {
    deps,
    sha256,
    list,
    listBytes,
    listHash,
    normalized: normalizePinned(path)!,
    settle: () => Promise.all(kept),
  };
}

const text = (response: Response) => response.text();

describe("servePinned", () => {
  it("serves a file whose list and bytes are in the store, asking no resolver", async () => {
    const { deps, sha256, listBytes, listHash, normalized } = await setup();
    await deps.store.put(listHash, listBytes);
    await deps.store.put(sha256, REAL);
    const response = await servePinned(normalized, deps);
    expect(await text(response)).toBe("export default 42");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.buildList).not.toHaveBeenCalled();
  });

  it("deletes a forged list, rebuilds it, and serves", async () => {
    const { deps, listHash, listBytes, normalized, settle } = await setup();
    await deps.store.put(listHash, toBytes('{"v":1,"files":{}}'));
    expect(await text(await servePinned(normalized, deps))).toBe("export default 42");
    await settle();
    expect(deps.warn).toHaveBeenCalled();
    expect(deps.buildList).toHaveBeenCalledWith("acct@h/pkg@h", "index.js");
    expect(deps.store.bytes.get(listHash)).toEqual(listBytes);
  });

  it("rebuilds a one-file list, as a redirect hands out, before a whole one", async () => {
    const { deps, listBytes, normalized } = await setup();
    deps.buildList.mockImplementation(async (_prefix: string, only?: string) =>
      only === "index.js" ? listBytes : toBytes('{"files":{},"v":1}')
    );
    expect(await text(await servePinned(normalized, deps))).toBe("export default 42");
    expect(deps.buildList).toHaveBeenCalledTimes(1);
    expect(deps.buildList).toHaveBeenCalledWith("acct@h/pkg@h", "index.js");
  });

  it("falls back to the whole list when the one-file rebuild doesn't match", async () => {
    const { deps, listBytes, normalized } = await setup();
    deps.buildList.mockImplementation(async (_prefix: string, only?: string) =>
      only === undefined ? listBytes : toBytes('{"files":{},"v":1}')
    );
    expect(await text(await servePinned(normalized, deps))).toBe("export default 42");
    expect(deps.buildList).toHaveBeenLastCalledWith("acct@h/pkg@h", undefined);
  });

  it("fails when the rebuilt list doesn't match the URL", async () => {
    const { deps, normalized } = await setup();
    deps.buildList.mockResolvedValue(toBytes('{"files":{},"v":1}'));
    await expect(servePinned(normalized, deps)).rejects.toBeInstanceOf(PinnedAbort);
  });

  it("deletes a forged file, rereads it at the list's heads, and serves", async () => {
    const { deps, sha256, normalized, settle } = await setup();
    await deps.store.put(sha256, FORGED);
    expect(await text(await servePinned(normalized, deps))).toBe("export default 42");
    await settle();
    expect(deps.resolve).toHaveBeenCalledWith("acct@h/pkg@h/index.js", "fh");
    expect(deps.warn).toHaveBeenCalled();
    expect(deps.store.bytes.get(sha256)).toEqual(REAL);
  });

  it("fails on a resolver's bytes that don't match, storing nothing", async () => {
    const { deps, sha256, normalized, settle } = await setup();
    deps.resolve.mockResolvedValue({ body: FORGED, contentType: "text/javascript" });
    await expect(servePinned(normalized, deps)).rejects.toBeInstanceOf(PinnedAbort);
    await settle();
    expect(deps.store.bytes.has(sha256)).toBe(false);
  });

  it("fails when a resolver answers anything but the bytes", async () => {
    const { deps, normalized } = await setup();
    deps.resolve.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(servePinned(normalized, deps)).rejects.toBeInstanceOf(PinnedAbort);
  });

  it("answers 404 for a tail the list doesn't cover", async () => {
    const { deps, listHash } = await setup();
    const response = await servePinned(normalizePinned(`acct@h/pkg@h~${listHash}/other.js`)!, deps);
    expect(response.status).toBe(404);
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("answers 404 for a tail named like an Object.prototype member", async () => {
    const { deps, listHash } = await setup();
    for (const tail of ["constructor", "toString", "__proto__"]) {
      const response = await servePinned(normalizePinned(`acct@h/pkg@h~${listHash}/${tail}`)!, deps);
      expect(response.status, tail).toBe(404);
    }
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("never stores bytes the list says not to", async () => {
    const { deps, sha256, normalized, settle } = await setup({ store: false });
    expect(await text(await servePinned(normalized, deps))).toBe("export default 42");
    await settle();
    expect(deps.store.bytes.has(sha256)).toBe(false);
  });

  it("reads and writes no store for a share link", async () => {
    const { deps, normalized } = await setup();
    const response = await servePinned(normalized, { ...deps, store: undefined });
    expect(await text(response)).toBe("export default 42");
  });

  it("serves a path with no list live and unchecked", async () => {
    const { deps } = await setup();
    const response = await servePinned(normalizePinned("acct@h/pkg@h/index.js")!, deps);
    expect(await text(response)).toBe("export default 42");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.resolve).toHaveBeenCalledWith("acct@h/pkg@h/index.js", undefined);
  });

  it("passes a resolver's redirect through for a path with no list", async () => {
    const { deps } = await setup();
    deps.resolve.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: "/@/acct@h/pkg@h~L" } })
    );
    const response = await servePinned(normalizePinned("acct@h/pkg@h")!, deps);
    expect(response.status).toBe(307);
  });
});

describe("keepFileList", () => {
  it("keeps a list in memory, and stores it only if every entry may be stored", async () => {
    const stored = await setup();
    expect(await keepFileList(stored.listBytes, stored.listHash, stored.deps)).toBe(true);
    await stored.settle();
    expect(stored.deps.lists.get(stored.listHash)).toEqual(stored.list);
    expect(stored.deps.store.bytes.has(stored.listHash)).toBe(true);

    const memory = await setup({ store: false });
    expect(await keepFileList(memory.listBytes, memory.listHash, memory.deps)).toBe(true);
    await memory.settle();
    expect(memory.deps.lists.has(memory.listHash)).toBe(true);
    expect(memory.deps.store.bytes.has(memory.listHash)).toBe(false);
  });

  it("refuses a list that doesn't hash to its name", async () => {
    const { deps, listBytes } = await setup();
    expect(await keepFileList(listBytes, "not-its-hash", deps)).toBe(false);
    expect(deps.lists.size).toBe(0);
  });
});

describe("sharedRequests", () => {
  it("shares one request among concurrent calls for a key, and forgets it once settled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fn = vi.fn(async (key: string) => (await gate, key));
    const shared = sharedRequests(fn);
    const all = [shared("a"), shared("a"), shared("a"), shared("b")];
    release();
    expect(await Promise.all(all)).toEqual(["a", "a", "a", "b"]);
    expect(fn).toHaveBeenCalledTimes(2);
    await shared("a");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("handoffRequest", () => {
  it("builds a path handoff that old resolvers decline", () => {
    const m = handoffRequest(new Request("https://p.test/@/acct/Projects"), "patchwork", {
      path: "acct/Projects",
    });
    expect(m.request.path).toBe("acct/Projects");
    expect(new URL(m.request.handoffURL).protocol).not.toBe("automerge:");
  });

  it("carries the heads to read at, or a request for the list", () => {
    const req = new Request("https://p.test/@/x");
    expect(handoffRequest(req, "patchwork", { path: "a@h/x", heads: "fh" }).request.heads).toBe("fh");
    expect(handoffRequest(req, "patchwork", { path: "a@h", list: true }).request.list).toBe(true);
  });

  it("builds a legacy handoff with no path", () => {
    const special = new URL("automerge:abc/x.js");
    const m = handoffRequest(new Request("https://p.test/automerge%3Aabc/x.js"), "patchwork", special);
    expect(m.request.handoffURL).toBe(special.href);
    expect(m.request.path).toBeUndefined();
  });
});
