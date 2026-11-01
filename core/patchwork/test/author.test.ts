// Every Repo Patchwork builds records its signer's verifying key as the
// Automerge author of its actors, however a document reaches it: created,
// loaded from storage, or synced from the server.
import { afterEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import {
  Repo,
  type DocHandle,
  type ManagedTransport,
  type PeerId,
} from "@automerge/automerge-repo";
import {
  MemorySigner,
  MemoryStorage,
  MessagePortTransport,
  Subduction,
} from "@automerge/automerge-subduction";
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js";
import { signerIdentity } from "@inkandswitch/patchwork-bootloader/signer";

const SERVICE = "sync.test";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop().catch(() => {})));
});

function startServer(): Subduction {
  return new Subduction({
    signer: MemorySigner.generate(),
    storage: new MemoryStorage(),
    serviceName: SERVICE,
  });
}

let repos = 0;

/** A Repo the way Patchwork builds one: its signer's key is its author. */
function patchworkRepo(
  signer: MemorySigner,
  config: { storage?: DummyStorageAdapter; server?: Subduction } = {}
): Repo {
  const { server } = config;
  const repo = new Repo({
    peerId: `repo-${repos++}` as PeerId,
    signer,
    author: signerIdentity(signer).verifyingKey,
    storage: config.storage,
    subductionWebsocketEndpoints: server && [
      {
        url: `ws://${SERVICE}`,
        async connect() {
          const { port1, port2 } = new MessageChannel();
          void server
            .acceptTransport(new MessagePortTransport(port2), SERVICE)
            .catch(() => {});
          const transport = new MessagePortTransport(port1);
          const closed = new Promise<void>((resolve) =>
            transport.onDisconnect(() => resolve())
          );
          return Object.assign(transport, {
            closed: () => closed,
          }) as unknown as ManagedTransport;
        },
      },
    ],
  });
  cleanup.push(() => repo.shutdown());
  return repo;
}

async function eventually(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type Doc = { count: number };

/** The actors `signer` has written to `handle`'s document as. */
function actorsOf(handle: DocHandle<Doc>, signer: MemorySigner): string[] {
  return A.getActorsForAuthor(
    handle.doc(),
    signerIdentity(signer).verifyingKey
  );
}

describe("signerIdentity", () => {
  it("names the signer by its Subduction peer id and hex verifying key", () => {
    const signer = MemorySigner.generate();
    const identity = signerIdentity(signer);
    expect(identity.peerId).toBe(signer.peerId().toString());
    expect(identity.verifyingKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("author", () => {
  it("is recorded for the actor that creates a document", () => {
    const signer = MemorySigner.generate();
    const handle = patchworkRepo(signer).create<Doc>({ count: 0 });
    handle.change((doc) => void doc.count++);

    expect(actorsOf(handle, signer)).toEqual([A.getActorId(handle.doc())]);
  });

  it("is recorded for a new actor after the document is loaded from storage", async () => {
    const signer = MemorySigner.generate();
    const storage = new DummyStorageAdapter();
    const first = patchworkRepo(signer, { storage });
    const created = first.create<Doc>({ count: 0 });
    await first.flush();
    await first.shutdown();

    const loaded = await patchworkRepo(signer, { storage }).find<Doc>(
      created.url
    );
    loaded.change((doc) => void doc.count++);

    const actor = A.getActorId(loaded.doc());
    expect(actorsOf(loaded, signer)).toHaveLength(2);
    expect(actorsOf(loaded, signer)).toContain(actor);
  });

  it("tells one signer's actors from another's in a synced document", async () => {
    const server = startServer();
    const mine = MemorySigner.generate();
    const theirs = MemorySigner.generate();
    const other = patchworkRepo(theirs, { server });
    const created = other.create<Doc>({ count: 0 });
    await eventually(() => other.isSubductionConnected());
    await other.flush();

    const tab = patchworkRepo(mine, { server });
    await eventually(() => tab.isSubductionConnected());
    const synced = await tab.find<Doc>(created.url);
    synced.change((doc) => void doc.count++);

    expect(actorsOf(synced, mine)).toEqual([A.getActorId(synced.doc())]);
    expect(actorsOf(synced, theirs)).toEqual([A.getActorId(created.doc())]);
  });
});
