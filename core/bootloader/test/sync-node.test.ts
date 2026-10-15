// Tabs syncing through the sync node. The tabs and the node share one storage
// adapter (standing in for the origin's IndexedDB) and one signer; the "sync
// server" is an in-process Subduction node reached over a MessageChannel, and
// "other" is someone else's Repo connected straight to it.
import { afterEach, describe, expect, it } from "vitest";
import {
  Repo,
  generateAutomergeUrl,
  type AutomergeUrl,
  type PeerId,
} from "@automerge/automerge-repo";
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction";

import { SyncNode } from "../src/sync-node.js";
import { PortSyncRemote } from "../src/sync-remote.js";
import {
  MemoryAdapter,
  SERVICE,
  endpointTo,
  eventually,
  type Server,
} from "./harness.js";

function startServer(): Server {
  return {
    subduction: new Subduction({
      signer: MemorySigner.generate(),
      storage: new MemoryStorage(),
      serviceName: SERVICE,
    }),
    up: true,
  };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop().catch(() => {})));
});

let origins = 0;

/** An origin: its storage, its signer, its sync node, and tabs on demand. */
function origin(server: Server) {
  const name = `origin-${origins++}`;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const storage = new MemoryAdapter();
  const startNode = () => {
    const node = new SyncNode({
      signer: MemorySigner.fromBytes(seed),
      storage,
      endpoints: [endpointTo(server)],
      log: () => {},
    });
    cleanup.push(() => node.shutdown());
    return node;
  };
  let node = startNode();
  let tabs = 0;
  const remote = () =>
    new PortSyncRemote(() => {
      const { port1, port2 } = new MessageChannel();
      node.connect(port2);
      return port1;
    });
  return {
    storage,
    remote,
    get node() {
      return node;
    },
    /** What a worker restart does: a fresh node on the same database. */
    async restartNode() {
      const old = node;
      node = startNode();
      await old.shutdown();
    },
    tab() {
      const repo = new Repo({
        peerId: `${name}-tab-${tabs++}` as PeerId,
        storage,
        signer: MemorySigner.fromBytes(seed),
        subductionRemote: remote(),
        headsChannel: `${name}-heads`,
      });
      cleanup.push(() => repo.shutdown());
      return repo;
    },
  };
}

function elsewhere(server: Server) {
  const repo = new Repo({
    peerId: `other-${origins++}` as PeerId,
    subductionWebsocketEndpoints: [endpointTo(server)],
  });
  cleanup.push(() => repo.shutdown());
  return repo;
}

/**
 * Look the document up from a fresh direct Repo until it shows `check`. A
 * Repo that synced before the push landed doesn't hear about it later, so
 * each attempt starts over.
 */
async function seenElsewhere(
  server: Server,
  url: AutomergeUrl,
  check: (doc: Doc) => boolean,
  ms = 20_000
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const repo = elsewhere(server);
    const doc = await repo
      .find<Doc>(url, { signal: AbortSignal.timeout(2_000) })
      .then((handle) => handle.doc())
      .catch(() => undefined);
    void repo.shutdown();
    if (doc && check(doc)) return;
    if (Date.now() > deadline)
      throw new Error(`${url} not seen within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type Doc = { text?: string; count?: number };

/**
 * Count the sync rounds the node runs with the server, each held open for
 * `delayMs` so that requests arriving meanwhile overlap it, as they would
 * behind a real network round trip.
 */
function countRounds(node: SyncNode, delayMs = 200) {
  const subduction = node.subduction as any;
  const real = subduction.syncWithAllPeers.bind(subduction);
  const counter = { rounds: 0 };
  subduction.syncWithAllPeers = async (...args: unknown[]) => {
    counter.rounds++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return real(...args);
  };
  return counter;
}

describe("sync node", () => {
  it("pushes a tab's edits to the server", async () => {
    const server = startServer();
    const tab = origin(server).tab();
    const handle = tab.create<Doc>({ count: 1 });
    handle.change((doc) => {
      doc.count = 2;
    });

    await seenElsewhere(server, handle.url, (doc) => doc.count === 2);
  });

  it("finds a document only the server has", async () => {
    const server = startServer();
    const other = elsewhere(server);
    const theirs = other.create<Doc>({ text: "from elsewhere" });
    await other.flush();

    const tab = origin(server).tab();
    const ours = await tab.find<Doc>(theirs.url);
    expect(ours.doc().text).toBe("from elsewhere");
  });

  it("delivers live edits from the server to a tab", async () => {
    const server = startServer();
    const other = elsewhere(server);
    const theirs = other.create<Doc>({ count: 0 });
    await other.flush();

    const ours = await origin(server).tab().find<Doc>(theirs.url);
    theirs.change((doc) => {
      doc.count = 7;
    });
    await eventually(() => ours.doc().count === 7);
  });

  it("carries one tab's edits to another tab", async () => {
    const server = startServer();
    const site = origin(server);
    const a = site.tab();
    const b = site.tab();
    const inA = a.create<Doc>({ count: 0 });
    await a.flush();
    const inB = await b.find<Doc>(inA.url);

    inA.change((doc) => {
      doc.count = 3;
    });
    await eventually(() => inB.doc().count === 3);
  });

  it("runs one round for many tabs opening the same document", async () => {
    const server = startServer();
    const other = elsewhere(server);
    const theirs = other.create<Doc>({ count: 1 });
    await other.flush();

    const site = origin(server);
    const tabs = Array.from({ length: 10 }, () => site.tab());
    const counter = countRounds(site.node);
    const found = await Promise.all(tabs.map((tab) => tab.find<Doc>(theirs.url)));

    expect(found.every((handle) => handle.doc().count === 1)).toBe(true);
    // None of them wrote anything, so the round the first started covers all.
    expect(counter.rounds).toBe(1);
  });

  it("pushes an edit made while a round is already running", async () => {
    const server = startServer();
    const site = origin(server);
    countRounds(site.node, 500);
    const tab = site.tab();
    const handle = tab.create<Doc>({ count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.change((doc) => {
      doc.count = 2;
    });

    await seenElsewhere(server, handle.url, (doc) => doc.count === 2);
  });

  it("pushes every tab's edit when they all write during a round", async () => {
    const server = startServer();
    const site = origin(server);
    const first = site.tab();
    const created = first.create<{ [tab: string]: number }>({});
    await first.flush();
    const tabs = [first, ...Array.from({ length: 4 }, () => site.tab())];
    const handles = await Promise.all(
      tabs.map((tab) => tab.find<{ [tab: string]: number }>(created.url))
    );

    const counter = countRounds(site.node, 300);
    handles.forEach((handle, i) =>
      handle.change((doc) => {
        doc[`tab${i}`] = i;
      })
    );

    await seenElsewhere(
      server,
      created.url,
      (doc: any) => handles.every((_, i) => doc[`tab${i}`] === i)
    );
    expect(counter.rounds).toBeLessThan(tabs.length);
  });

  it("follows the node across a worker restart", async () => {
    const server = startServer();
    const site = origin(server);
    const tab = site.tab();
    const handle = tab.create<Doc>({ count: 1 });
    await seenElsewhere(server, handle.url, (doc) => doc.count === 1);

    await site.restartNode();
    handle.change((doc) => {
      doc.count = 2;
    });
    await seenElsewhere(server, handle.url, (doc) => doc.count === 2);
  });

  it("reports a document nobody has as unavailable", async () => {
    const server = startServer();
    const tab = origin(server).tab();
    await expect(tab.find(generateAutomergeUrl())).rejects.toThrow(
      /unavailable/
    );
  });

  it("keeps looking while the server is unreachable", async () => {
    const server = startServer();
    server.up = false;
    const tab = origin(server).tab();
    let settled = false;
    void tab.find(generateAutomergeUrl()).then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(settled).toBe(false);
  });

  it("pushes edits made while the server was unreachable once it's back", async () => {
    const server = startServer();
    server.up = false;
    const tab = origin(server).tab();
    const handle = tab.create<Doc>({ text: "offline" });
    await tab.flush();

    server.up = true;
    await seenElsewhere(server, handle.url, (doc) => doc.text === "offline");
  });

  it("relays keyhive frames between the server and every listening tab", async () => {
    const server = startServer();
    const toServer: Uint8Array[] = [];
    await server.subduction.registerFrameHandler({
      onMessage: (payload: Uint8Array) => toServer.push(payload),
      onPeerDisconnect: () => {},
    });
    const site = origin(server);
    const relays = [site.remote().keyhiveRelay(), site.remote().keyhiveRelay()];
    const heard: Uint8Array[][] = relays.map(() => []);
    await Promise.all(
      relays.map((relay, i) =>
        relay.registerFrameHandler({
          onMessage: (payload) => heard[i].push(payload),
          onPeerDisconnect: () => {},
        })
      )
    );

    // What ARK does first: wait for the server to show up as a peer.
    let peers: Awaited<ReturnType<(typeof relays)[0]["getConnectedPeerIds"]>> =
      [];
    await eventually(() => {
      void relays[0].getConnectedPeerIds().then((found) => (peers = found));
      return peers.length > 0;
    });
    const serverPeer = peers[0];

    await relays[1].sendKeyhiveMessage(new Uint8Array([1, 2, 3]), serverPeer);
    await eventually(() => toServer.length === 1);
    expect([...toServer[0]]).toEqual([1, 2, 3]);

    const [nodePeer] = await server.subduction.getConnectedPeerIds();
    await server.subduction.sendKeyhiveMessage(
      new Uint8Array([4, 5]),
      nodePeer
    );
    await eventually(() => heard.every((frames) => frames.length === 1));
    expect(heard.map((frames) => [...frames[0]])).toEqual([
      [4, 5],
      [4, 5],
    ]);
  });
});
