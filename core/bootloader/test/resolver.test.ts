import { describe, it, expect } from "vitest";
import {
  Repo,
  encodeHeads,
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { idhash, livePath, pinnedPath } from "@inkandswitch/patchwork-filesystem";
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
  const foo = folder(repo, { notes: file(repo, "hi") });
  const root = folder(repo, { Projects: folder(repo, { foo: foo.url }).url });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }] },
  });
  const a = await idhash(account.documentId);
  const accounts = new Map([[a, account.url]]);
  const resolver = createResolver(() => Promise.resolve(repo), undefined, () => accounts);
  return { repo, a, accounts, account, resolver };
}

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
  it("redirects a live path to its pinned form", async () => {
    const { repo, a, accounts, resolver } = await fixture();
    const live = livePath(a, ["Projects", "foo", "notes"]);
    const reply = await resolver.answer(pathRequest(live));
    expect(reply?.type).toBe("response");
    expect(inline(reply).status).toBe(307);
    expect(inline(reply).headers?.location).toBe(
      `/@/${await pinnedPath(repo, live, { accounts })}`
    );
    expect(inline(reply).headers?.["cache-control"]).toBe("no-store");
  });

  it("answers a pinned path with its bytes inline", async () => {
    const { repo, a, accounts, resolver } = await fixture();
    const pinned = await pinnedPath(repo, livePath(a, ["Projects", "foo", "notes"]), { accounts });
    const reply = await resolver.answer(pathRequest(pinned!));
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
