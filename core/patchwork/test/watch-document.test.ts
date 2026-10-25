// Watching a document through a tab's own Subduction node. The "sync server"
// is an in-process Subduction node reached over a MessageChannel; an origin is
// its tabs' shared storage and signer, and "other" is someone else's Repo.
import { afterEach, describe, expect, it } from "vitest";
import {
  Repo,
  type AutomergeUrl,
  type ManagedTransport,
  type PeerId,
  type WebSocketEndpointInterface,
} from "@automerge/automerge-repo";
import {
  MemorySigner,
  MemoryStorage,
  MessagePortTransport,
  Subduction,
} from "@automerge/automerge-subduction";
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js";

import { HEADS_CHANNEL } from "../src/repo.js";
import { watchDocument } from "../src/watch-document.js";

const SERVICE = "sync.test";

type Server = { subduction: Subduction };

function startServer(): Server {
  return {
    subduction: new Subduction({
      signer: MemorySigner.generate(),
      storage: new MemoryStorage(),
      serviceName: SERVICE,
    }),
  };
}

function endpointTo(server: Server): WebSocketEndpointInterface {
  return {
    url: `ws://${SERVICE}`,
    async connect() {
      const { port1, port2 } = new MessageChannel();
      void server.subduction
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
  };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop().catch(() => {})));
});

let repos = 0;

function connectedRepo(server: Server, config: Partial<ConstructorParameters<typeof Repo>[0]> = {}) {
  const repo = new Repo({
    peerId: `repo-${repos++}` as PeerId,
    subductionWebsocketEndpoints: [endpointTo(server)],
    ...config,
  });
  cleanup.push(() => repo.shutdown());
  return repo;
}

/** Tabs on one origin: one database, one signer, one heads channel. */
function origin(server: Server) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const storage = new DummyStorageAdapter();
  return () =>
    connectedRepo(server, {
      storage,
      signer: MemorySigner.fromBytes(seed),
      headsChannel: HEADS_CHANNEL,
    });
}

async function eventually(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const connected = (repo: Repo) => eventually(() => repo.isSubductionConnected());

type Doc = { count: number };

/** Watch `url` from `repo`, recording every `seen`. */
function record(repo: Repo, url: AutomergeUrl) {
  const heard: Array<string | undefined> = [];
  const unwatch = watchDocument(repo, url, (seen) => heard.push(seen));
  cleanup.push(async () => unwatch());
  return heard;
}

describe("watchDocument", () => {
  it("hears someone else's change without loading the document", async () => {
    const server = startServer();
    const other = connectedRepo(server);
    const handle = other.create<Doc>({ count: 0 });
    await connected(other);
    await other.flush();

    const tab = origin(server)();
    await connected(tab);
    const heard = record(tab, handle.url);
    await eventually(() => heard.length > 0);
    const before = heard.at(-1);

    handle.change((doc) => void doc.count++);
    await eventually(() => heard.some((seen) => seen && seen !== before));

    expect(tab.handles[handle.documentId]).toBeUndefined();
  });

  it("hears a change another tab on the origin makes", async () => {
    const server = startServer();
    const tab = origin(server);
    const writer = tab();
    const watcher = tab();
    await Promise.all([connected(writer), connected(watcher)]);
    const handle = writer.create<Doc>({ count: 0 });
    await writer.flush();

    const heard = record(watcher, handle.url);
    const already = heard.length;
    handle.change((doc) => void doc.count++);
    await eventually(() => heard.length > already);

    expect(watcher.handles[handle.documentId]).toBeUndefined();
  });

  it("stops calling once unwatched", async () => {
    const server = startServer();
    const other = connectedRepo(server);
    const handle = other.create<Doc>({ count: 0 });
    await connected(other);
    await other.flush();

    const tab = origin(server)();
    await connected(tab);
    const heard: Array<string | undefined> = [];
    const unwatch = watchDocument(tab, handle.url, (seen) => heard.push(seen));
    await eventually(() => heard.length > 0);
    unwatch();
    const stopped = heard.length;

    handle.change((doc) => void doc.count++);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(heard.length).toBe(stopped);
  });
});
