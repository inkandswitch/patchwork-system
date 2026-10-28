import { afterEach, describe, it, expect } from "vitest";
import { Repo, stringifyAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import { contentHash, livePath, toBytes } from "@inkandswitch/patchwork-filesystem";
import {
  handleResolveRequest,
  registerAccount,
  resolveHandoffsWith,
} from "../src/tab-resolver.js";
import {
  ORIGIN,
  navigation,
  startServiceWorker,
  type ServiceWorkerHarness,
} from "./service-worker-harness.js";

let sw: ServiceWorkerHarness | undefined;
afterEach(() => {
  sw?.close();
  sw = undefined;
});

/** A tab that answers the service worker with `repo`, as tab-resolver.ts does in a page. */
function addTab(harness: ServiceWorkerHarness, repo: Repo, id = "tab") {
  resolveHandoffsWith(repo);
  harness.clients.set(id, {
    id,
    type: "window",
    url: `${ORIGIN}/`,
    focused: true,
    visibilityState: "visible",
    postMessage(message, transfer) {
      handleResolveRequest(
        new MessageEvent("message", {
          data: message,
          ports: (transfer ?? []) as MessagePort[],
        })
      );
    },
  });
}

describe("service worker: legacy automerge URLs", () => {
  it("keeps an immutable navigation under its own URL, not over the app shell", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const doc = repo.create({
      "@patchwork": { type: "directory" },
      "index.html": { content: "<h1>a doc</h1>", mimeType: "text/html" },
    });
    const url = stringifyAutomergeUrl({ documentId: doc.documentId, heads: doc.heads() });
    const request = navigation(`${ORIGIN}/${encodeURIComponent(url)}/index.html`);

    const event = sw.fetch(request, "tab");
    const response = await event.response()!;
    expect(await response.text()).toBe("<h1>a doc</h1>");
    await event.settled();

    const kept = [...(sw.caches.named.get("patchwork")?.entries.keys() ?? [])];
    expect(kept).toEqual([request.url]);
  });
});

/** An account whose / is a folder Projects/foo holding one file, `notes`. */
async function account(repo: Repo) {
  const file = (content: string) =>
    repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" });
  const folder = (entries: Record<string, AutomergeUrl>) =>
    repo.create({
      title: "folder",
      docs: Object.entries(entries).map(([name, url]) => ({ name, type: "x", url })),
    });
  const notes = file("hi");
  const foo = folder({ notes: notes.url });
  const root = folder({ Projects: folder({ foo: foo.url }).url });
  const acct = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }] },
  });
  const a = await registerAccount(acct.url);
  return { a, notes };
}

/** Follow a live /@/ URL's redirect, as fetch() would: the pinned URL it names. */
async function pin(harness: ServiceWorkerHarness, live: string) {
  const response = await harness.fetch(new Request(`${ORIGIN}/@/${live}`), "tab").response()!;
  expect(response.status).toBe(307);
  expect(response.body).toBeNull();
  return `${ORIGIN}${response.headers.get("location")}`;
}

describe("service worker: /@/ paths", () => {
  it("redirects a live path, then serves the pinned file from its list", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const { a } = await account(repo);

    const pinned = await pin(sw, livePath(a, ["Projects", "foo", "notes"]));
    const event = sw.fetch(new Request(pinned), "tab");
    const response = await event.response()!;
    expect(await response.text()).toBe("hi");
    expect(response.headers.get("cache-control")).toContain("immutable");
    await event.settled();
    // the list and the file's bytes, each under its own hash
    const stored = sw.caches.named.get(`patchwork-content-${a}`)!;
    expect(stored.entries.size).toBe(2);
    expect(await stored.match(`${ORIGIN}/.content/${await contentHash(toBytes("hi"))}`)).toBeDefined();
  });

  it("serves the old bytes for a pinned URL after the file changed", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const { a, notes } = await account(repo);
    const pinned = await pin(sw, livePath(a, ["Projects", "foo", "notes"]));

    notes.change((d: any) => (d.content = "changed"));
    // nothing stored: the bytes come from a resolver, read at the heads the list recorded
    await sw.caches.delete(`patchwork-content-${a}`);
    expect(await (await sw.fetch(new Request(pinned), "tab").response()!).text()).toBe("hi");
  });

  it("serves a redirect's pinned URL again after the service worker restarts", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const { a } = await account(repo);
    const pinned = await pin(sw, livePath(a, ["Projects", "foo", "notes"]));

    // a fresh service worker: no lists in memory, and nothing stored
    sw.close();
    sw = await startServiceWorker();
    addTab(sw, repo);
    expect(await (await sw.fetch(new Request(pinned), "tab").response()!).text()).toBe("hi");
  });

  it("never serves a forged store entry", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const { a } = await account(repo);
    const pinned = await pin(sw, livePath(a, ["Projects", "foo", "notes"]));
    const first = sw.fetch(new Request(pinned), "tab");
    await (await first.response()!).text();
    await first.settled();

    const key = `${ORIGIN}/.content/${await contentHash(toBytes("hi"))}`;
    const store = sw.caches.named.get(`patchwork-content-${a}`)!;
    await store.put(key, new Response("forged"));
    const again = sw.fetch(new Request(pinned), "tab");
    expect(await (await again.response()!).text()).toBe("hi");
    await again.settled();
    expect(await (await store.match(key))!.text()).toBe("hi");
  });

  it("fails, rather than serving, when a tab answers with other bytes", async () => {
    sw = await startServiceWorker();
    const repo = new Repo();
    addTab(sw, repo);
    const { a } = await account(repo);
    const pinned = await pin(sw, livePath(a, ["Projects", "foo", "notes"]));

    // a tab that answers everything with bytes of its own
    sw.clients.set("tab", {
      id: "tab",
      type: "window",
      url: `${ORIGIN}/`,
      focused: true,
      visibilityState: "visible",
      postMessage(message: any, transfer) {
        const [port] = (transfer ?? []) as MessagePort[];
        if (!port) return; // not a request to resolve
        port.postMessage({ type: "accepted" });
        port.postMessage({
          id: message.id,
          type: "response",
          response: { status: 200, body: toBytes("forged"), headers: { "content-type": "text/plain" } },
        });
      },
    });
    await expect(sw.fetch(new Request(pinned), "tab").response()!).rejects.toThrow();
  });
});

describe("service worker: lifecycle", () => {
  it("keeps content stores when it clears old caches", async () => {
    sw = await startServiceWorker();
    await sw.caches.open("patchwork-content-acct");
    await sw.caches.open("some-old-cache");
    await sw.lifecycle("activate");
    expect((await sw.caches.keys()).sort()).toEqual(["patchwork", "patchwork-content-acct"]);
  });
});
