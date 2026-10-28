import { describe, it, expect } from "vitest";
import {
  Repo,
  encodeHeads,
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import {
  contentHash,
  formatHeads,
  idhash,
  livePath,
  parseFileList,
  pinnedPath,
  walkPath,
} from "@inkandswitch/patchwork-filesystem";
import { createResolver } from "../src/resolver.js";
import { registerAccount, resolveHandoffsWith, handleResolveRequest } from "../src/tab-resolver.js";
import type { HandoffRequestMessage, HandoffResponseMessage } from "../src/types.js";

// No `caches` in node: a resolver that still wrote the cache would throw.

const file = (repo: Repo, content: string) =>
  repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" }).url;
const folder = (repo: Repo, entries: Record<string, AutomergeUrl>) =>
  repo.create({
    title: "folder",
    docs: Object.entries(entries).map(([name, url]) => ({ name, type: "x", url })),
  });

async function fixture() {
  const repo = new Repo();
  const notes = file(repo, "hi");
  const foo = folder(repo, { notes });
  const root = folder(repo, { Projects: folder(repo, { foo: foo.url }).url });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }] },
  });
  const a = await idhash(account.documentId);
  const accounts = new Map([[a, account.url]]);
  const resolver = createResolver(() => Promise.resolve(repo), undefined, () => accounts);
  return { repo, a, accounts, account, resolver, notes };
}

/** A path's chain of doc steps, without file lists: what a resolver is asked to read. */
const chain = async (repo: Repo, path: string, accounts: ReadonlyMap<string, AutomergeUrl>) =>
  (await walkPath(repo, path, { accounts }))!.pinned;

const withRequest = (
  path: string,
  extra: { heads?: string; list?: boolean }
): HandoffRequestMessage => {
  const message = pathRequest(path);
  return { ...message, request: { ...message.request, ...extra } };
};

const pathRequest = (path: string): HandoffRequestMessage => ({
  id: "1",
  type: "request",
  cachename: "patchwork",
  request: {
    url: `https://p.test/@/${path}`,
    handoffURL: `patchwork-path:${path}`,
    path,
    headers: {},
    method: "GET",
    destination: "script",
    referrer: "",
  },
});

const inline = (reply: unknown) => (reply as HandoffResponseMessage).response;
const body = (reply: unknown) => {
  const b = inline(reply).body;
  return typeof b === "string" ? b : new TextDecoder().decode(b);
};

describe("resolver: /@/ paths", () => {
  it("answers a live path with a 307 whose body is the list it names", async () => {
    const { repo, a, accounts, resolver } = await fixture();
    const live = livePath(a, ["Projects", "foo", "notes"]);
    const reply = await resolver.answer(pathRequest(live));
    expect(reply?.type).toBe("response");
    expect(inline(reply).status).toBe(307);
    const pinned = await pinnedPath(repo, live, { accounts, only: "end" });
    expect(inline(reply).headers?.location).toBe(`/@/${pinned!.path}`);
    expect(inline(reply).headers?.["cache-control"]).toBe("no-store");
    const list = inline(reply).body as Uint8Array;
    expect(pinned!.path).toContain(`~${await contentHash(list)}/notes`);
    expect(Object.keys(parseFileList(list)!.files)).toEqual(["notes"]);
  });

  it("answers a container's full list", async () => {
    const { repo, a, accounts, resolver } = await fixture();
    const foo = await chain(repo, livePath(a, ["Projects", "foo"]), accounts);
    const reply = await resolver.answer(withRequest(foo, { list: true }));
    expect(inline(reply).status).toBe(200);
    const pinned = await pinnedPath(repo, foo, { accounts });
    expect(inline(reply).body).toEqual(pinned!.list);
  });

  it("reads a file at given heads, after it changed", async () => {
    const { repo, a, accounts, resolver, notes } = await fixture();
    const path = await chain(repo, livePath(a, ["Projects", "foo", "notes"]), accounts);
    const handle = await repo.find<{ content: string }>(notes);
    const heads = formatHeads(handle.heads());
    handle.change((d) => (d.content = "changed"));
    expect(body(await resolver.answer(pathRequest(path)))).toBe("changed");
    expect(body(await resolver.answer(withRequest(path, { heads })))).toBe("hi");
  });

  it("answers a pinned path with its bytes inline", async () => {
    const { repo, a, accounts, resolver } = await fixture();
    const pinned = await chain(repo, livePath(a, ["Projects", "foo", "notes"]), accounts);
    const reply = await resolver.answer(pathRequest(pinned));
    expect(inline(reply).status).toBe(200);
    expect(inline(reply).headers?.["content-type"]).toBe("text/plain");
    expect(body(reply)).toBe("hi");
  });

  it("redirects a pinned-looking path that isn't canonical", async () => {
    const { repo, a, account, resolver } = await fixture();
    const heads = [...account.heads()].sort().join(".");
    const reply = await resolver.answer(pathRequest(`${a}@${heads}/Projects`));
    expect(inline(reply).status).toBe(307);
    void repo;
  });

  it("answers an unknown path with 404", async () => {
    const { a, resolver } = await fixture();
    const reply = await resolver.answer(pathRequest(livePath(a, ["nope"])));
    expect(inline(reply).status).toBe(404);
  });

  it("aborts a pinned path whose heads never arrive", async () => {
    const { a, resolver } = await fixture();
    const [unknown] = encodeHeads(["00".repeat(32)]);
    const reply = await resolver.answer(
      pathRequest(`${a}@${unknown}/Projects`),
      AbortSignal.timeout(200)
    );
    expect(reply?.type).toBe("abort");
  });

  it("answers 404 for heads that can't be heads", async () => {
    const { a, resolver } = await fixture();
    const reply = await resolver.answer(pathRequest(`${a}@3vQB7B6MrGQZaxCuFg4oh/Projects`));
    expect(inline(reply).status).toBe(404);
  });
});

describe("resolver: accounts it doesn't know", () => {
  it("a tab declines, so another tab or the worker is asked", async () => {
    const { repo, a } = await fixture();
    const tab = createResolver(() => Promise.resolve(repo), undefined, () => new Map(), {
      declineUnknownAccounts: true,
    });
    expect(await tab.answer(pathRequest(livePath(a, ["Projects"])))).toBeUndefined();
  });

  it("the worker, asked last, answers 404", async () => {
    const { repo, a } = await fixture();
    const worker = createResolver(() => Promise.resolve(repo), undefined, () => new Map());
    const reply = await worker.answer(pathRequest(livePath(a, ["Projects"])));
    expect(inline(reply).status).toBe(404);
  });
});

describe("resolver: legacy automerge URLs", () => {
  it("answers inline, leaving caching to the service worker", async () => {
    const { repo, resolver } = await fixture();
    const pkg = repo.create({
      "@patchwork": { type: "directory" },
      "index.js": { content: "export default 1", mimeType: "text/javascript" },
    });
    const url = stringifyAutomergeUrl({ documentId: pkg.documentId, heads: pkg.heads() });
    const reply = await resolver.answer({
      ...pathRequest(""),
      request: {
        url: `https://p.test/${encodeURIComponent(url)}/index.js`,
        handoffURL: `${url}/index.js`,
        headers: {},
        method: "GET",
        destination: "script",
        referrer: "",
      },
    });
    expect(reply?.type).toBe("response");
    expect(inline(reply).status).toBe(200);
    expect(inline(reply).headers?.["cache-control"]).toContain("immutable");
    expect(body(reply)).toBe("export default 1");
  });
});

describe("registerAccount", () => {
  it("makes the tab's resolver answer for that account", async () => {
    const { repo, a, account } = await fixture();
    resolveHandoffsWith(repo);
    expect(await registerAccount(account.url)).toBe(a);

    const { port1, port2 } = new MessageChannel();
    const replies: unknown[] = [];
    port1.onmessage = (event) => replies.push(event.data);
    const handled = handleResolveRequest(
      new MessageEvent("message", {
        data: { ...pathRequest(livePath(a, ["Projects"])), type: "resolve" },
        ports: [port2],
      })
    );
    expect(handled).toBe(true);
    await expect.poll(() => replies.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    port1.close();
    expect(inline(replies.at(-1)).status).toBe(307);
  });
});
