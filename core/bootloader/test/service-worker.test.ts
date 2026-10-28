import { afterEach, describe, it, expect } from "vitest";
import { Repo, stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { handleResolveRequest, resolveHandoffsWith } from "../src/tab-resolver.js";
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

describe("service worker: the index channel", () => {
  it("refuses an answer posted by a page", async () => {
    sw = await startServiceWorker();
    sw.clients.set("page", { id: "page", type: "window", url: `${ORIGIN}/`, postMessage() {} });
    const event = sw.fetch(
      new Request(`${ORIGIN}/@/.index`, {
        method: "POST",
        body: JSON.stringify({ id: "x", path: "a@h", manifest: { prefix: "a@h", entries: {} } }),
      }),
      "page"
    );
    expect((await event.response()!).status).toBe(403);
  });

  it("answers a probe so the worker knows its fetches arrive", async () => {
    sw = await startServiceWorker();
    const response = await sw.fetch(new Request(`${ORIGIN}/@/.index`)).response()!;
    expect(response.headers.get("x-patchwork-index")).toBe("present");
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
