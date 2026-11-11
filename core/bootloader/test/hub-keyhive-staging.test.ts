// The hub's keyhive against the real staging sync server: encrypted documents
// go up, an identity they were shared with reads them back, and a stranger
// can't. Talks to the network, so it only runs with PATCHWORK_NETWORK_TESTS=1.
import "@automerge/automerge";
import "@automerge/subduction";
import "@keyhive/keyhive";
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js";
import { parseAutomergeUrl } from "@automerge/automerge-repo/slim";
import { describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub/hub.js";

const STAGING = "wss://staging.subduction.sync.inkandswitch.com";
const run = process.env.PATCHWORK_NETWORK_TESTS ? describe : describe.skip;

async function hub(): Promise<Hub> {
  const kv = new DummySubductionStorageAdapter();
  const documents = new DummySubductionStorageAdapter();
  const h = await createHub({
    syncServer: { url: STAGING, keyhive: true },
    storagePrefix: "test",
    stores: {
      kv,
      documents,
      publicDocuments: new DummySubductionStorageAdapter(),
    },
  });
  await h.network.connected();
  await h.hive!.sync();
  return h;
}

run("hub keyhive on staging", () => {
  it("stores encrypted docs that only members can read", async () => {
    const [a, b, stranger] = await Promise.all([hub(), hub(), hub()]);
    await a.hive!.setAccess(await b.hive!.contactCard(), "read");

    const handle = await a.repo.create<{ n: number; text?: string }>({ n: 0 });
    // the upstream create-then-change race: give the first round a moment
    await new Promise((r) => setTimeout(r, 1500));
    await handle.change((d) => {
      d.n = 1;
      d.text = "secret";
    });
    await a.repo.flush();
    const id = parseAutomergeUrl(handle.url).binaryDocumentId;
    expect(await a.hive!.canWrite(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));

    await b.hive!.sync();
    expect(await b.hive!.canRead(id)).toBe(true);
    expect(await b.hive!.canWrite(id)).toBe(false);
    const found = await b.repo.find<{ n: number; text?: string }>(handle.url, {
      signal: AbortSignal.timeout(20_000),
    });
    // the first commit can land before the second
    await vi.waitUntil(() => found.hasHeads(handle.heads()), {
      timeout: 15_000,
      interval: 100,
    });
    expect(found.doc()).toEqual({ n: 1, text: "secret" });

    // the stranger gets ciphertext it can't open, so the doc never loads
    expect(await stranger.hive!.canRead(id)).toBe(false);
    const query = stranger.repo.query(handle.url);
    await new Promise((r) => setTimeout(r, 5000));
    expect(query.state().status).not.toBe("ready");

    await Promise.all([a.close(), b.close(), stranger.close()]);
  }, 120_000);

  it("reads documents made public to patchwork through the public pair", async () => {
    const [a, stranger] = await Promise.all([hub(), hub()]);
    await a.hive!.setAccess("public", "read");
    const handle = await a.repo.create<{ hello: string }>({ hello: "world" });
    await a.repo.flush();
    await new Promise((r) => setTimeout(r, 2000));

    await stranger.publicReader!.sync();
    const id = parseAutomergeUrl(handle.url).binaryDocumentId;
    expect(await stranger.publicReader!.canRead(id)).toBe(true);
    expect(await stranger.hive!.canWrite(id)).toBe(false);
    const found = await stranger.repo.find<{ hello: string }>(handle.url, {
      signal: AbortSignal.timeout(20_000),
    });
    expect(found.doc()).toEqual({ hello: "world" });

    await Promise.all([a.close(), stranger.close()]);
  }, 120_000);

  it("sends a change made straight after create (no keyhive)", async () => {
    const plain = async () => {
      const h = await createHub({
        syncServer: { url: STAGING },
        storagePrefix: "test",
        stores: {
          kv: new DummySubductionStorageAdapter(),
          documents: new DummySubductionStorageAdapter(),
        },
      });
      await h.network.connected();
      return h;
    };
    const [a, b] = await Promise.all([plain(), plain()]);
    const handle = await a.repo.create<{ v: number }>({ v: 0 });
    await handle.change((d) => {
      d.v = 1;
    });
    // the server needs a moment to have the document at all; unpatched,
    // waiting doesn't help: the v = 1 change never reaches it
    await new Promise((r) => setTimeout(r, 2000));
    const found = await b.repo.find<{ v: number }>(handle.url, {
      signal: AbortSignal.timeout(20_000),
    });
    await vi.waitUntil(() => found.doc()?.v === 1, {
      timeout: 10_000,
      interval: 100,
    });
    await handle.change((d) => {
      d.v = 2;
    });
    await vi.waitUntil(() => found.doc()?.v === 2, {
      timeout: 10_000,
      interval: 100,
    });
    await Promise.all([a.close(), b.close()]);
  }, 60_000);
});
