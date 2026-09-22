// A subduction node for a worker. A Repo with this origin's IndexedDB, a
// socket to the sync server and (optionally) a BroadcastChannel mesh to the
// other nodes on the origin. It never opens a document itself: tabs are
// storageless Repos that reach it over MessagePorts and sync through it.
import {
  documentIdToBinary,
  initializeWasm,
  Repo,
  WebSocketTransport,
  type DocumentId,
  type ManagedTransport,
  type PeerId,
  type WebSocketEndpointInterface,
} from "@automerge/automerge-repo/slim";
import {
  MemorySigner,
  SedimentreeId,
} from "@automerge/automerge-subduction/slim";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { MessagePortTransport, WORKER_SUBDUCTION_SERVICE } from "./worker-link.js";
import type {
  ControlPort,
  NodeConfig,
  NodeMessage,
  TabMessage,
} from "./protocol.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RELAY_TIMEOUT_MS = 30_000;

function toSedimentreeId(documentId: string): SedimentreeId {
  const binary = documentIdToBinary(documentId as DocumentId);
  if (!binary) throw new Error(`not a document id: ${documentId}`);
  const bytes = new Uint8Array(32);
  bytes.set(binary);
  return SedimentreeId.fromBytes(bytes);
}

/**
 * The server socket, observable and switchable. automerge-repo's reconnect
 * loop calls `connect()`; while offline that fails like a dead network would,
 * so the loop backs off exactly as a tab's does.
 */
class ServerEndpoint implements WebSocketEndpointInterface {
  #live: WebSocketTransport | null = null;
  #offline = false;

  constructor(
    readonly url: string,
    readonly events: { onOpen(): void; onClosed(): void }
  ) {}

  async connect(): Promise<ManagedTransport> {
    if (this.#offline) throw new Error("offline");
    const transport = await WebSocketTransport.connect(this.url);
    if (this.#offline) {
      void transport.disconnect();
      throw new Error("offline");
    }
    this.#live = transport;
    this.events.onOpen();
    void transport.closed().then(() => {
      if (this.#live === transport) this.#live = null;
      this.events.onClosed();
    });
    return transport;
  }

  setOffline(offline: boolean): void {
    this.#offline = offline;
    if (offline) void this.#live?.disconnect();
  }
}

type Node = {
  peerId: string;
  accept(port: MessagePort): void;
  setOffline(offline: boolean): void;
  connected(): boolean;
  remoteHeads(): Map<string, Map<string, string[]>>;
};

async function build(
  config: NodeConfig,
  broadcast: (message: NodeMessage) => void
): Promise<Node> {
  if (config.server !== "none" && !config.serverPeer) {
    throw new Error(
      "a worker node needs the server's peer id (?serverPeer=) to tell it from the tabs"
    );
  }
  const [automergeWasm, subductionWasm] = await Promise.all([
    fetch("/automerge.wasm").then((r) => r.bytes()),
    fetch("/subduction.wasm").then((r) => r.bytes()),
  ]);
  await initializeWasm(automergeWasm);
  initSubductionSync({ module: subductionWasm });

  const signer = new MemorySigner();
  const remoteHeads = new Map<string, Map<string, string[]>>();
  let socketOpen = false;
  let connected = false;
  const setConnected = (value: boolean) => {
    if (value === connected) return;
    connected = value;
    broadcast({ type: "connection", connected });
  };
  const log = (message: string) =>
    broadcast({ type: "log", message: `${Math.round(performance.now())}ms ${message}` });

  const endpoint =
    config.server === "none"
      ? null
      : new ServerEndpoint(config.server, {
          onOpen() {
            log("server socket open");
            socketOpen = true;
            void awaitHandshake();
          },
          onClosed() {
            log("server socket closed");
            socketOpen = false;
            setConnected(false);
          },
        });

  const repo = new Repo({
    signer,
    storage: new IndexedDBStorageAdapter(),
    peerId: `bench-node-${crypto.randomUUID()}` as PeerId,
    subductionWebsocketEndpoints: endpoint ? [endpoint] : [],
    subductionAdapters: config.siblings
      ? [
          {
            adapter: new BroadcastChannelNetworkAdapter({
              channelName: "bench-nodes",
            }),
            serviceName: "bench-nodes",
            role: "mesh",
          },
        ]
      : [],
    enableRemoteHeadsGossiping: true,
  });

  // A node that never opens a document has nothing driving sync rounds: it
  // stores what a tab pushes and answers what a peer asks, but doesn't carry
  // one peer's commits to another on its own. So when a tab (or a mesh peer)
  // announces heads, run a round for that document with every peer, which
  // pushes the commits to the server and to the other tabs and subscribes to
  // updates. One round in flight per document; announcements during it run
  // one more.
  const relaying = new Map<string, boolean>();
  async function relay(documentId: string) {
    if (relaying.has(documentId)) {
      relaying.set(documentId, true);
      return;
    }
    const subduction = await repo.subduction;
    do {
      relaying.set(documentId, false);
      try {
        await subduction.syncWithAllPeers(
          toSedimentreeId(documentId),
          true,
          RELAY_TIMEOUT_MS
        );
      } catch (error) {
        log(`relay of ${documentId.slice(0, 8)} failed: ${error}`);
      }
    } while (relaying.get(documentId));
    relaying.delete(documentId);
  }

  // Every peer's heads go to the tabs, which know which peer is the server.
  repo.on("subduction-remote-heads", ({ documentId, storageId, heads }) => {
    let byPeer = remoteHeads.get(documentId);
    if (!byPeer) remoteHeads.set(documentId, (byPeer = new Map()));
    byPeer.set(storageId, [...heads]);
    broadcast({ type: "remote-heads", documentId, storageId, heads: [...heads] });
    if (storageId !== config.serverPeer) void relay(documentId);
  });

  // The socket being open is not the handshake being done; the server counts
  // as connected once it shows up among the peers.
  async function awaitHandshake() {
    while (socketOpen && !connected) {
      const peers = await repo.connectedSubductionPeerIds();
      if (config.serverPeer && peers.includes(config.serverPeer)) {
        log(`server handshake done; peers: ${peers.length}`);
        setConnected(true);
        // Whatever the tabs did while the server was away goes up now.
        for (const documentId of remoteHeads.keys()) void relay(documentId);
        return;
      }
      await sleep(10);
    }
  }

  const subduction = await repo.subduction;
  (self as any).repo = repo;

  return {
    peerId: signer.peerId().toString(),
    // The responder half of the handshake: it settles only once the tab
    // initiates, and the tab only initiates once told the port is being read,
    // so this must not be awaited before replying.
    accept(port) {
      void subduction
        .acceptTransport(
          new MessagePortTransport(port),
          WORKER_SUBDUCTION_SERVICE
        )
        .then(
          (peerId) => log(`accepted tab ${peerId.toString().slice(0, 8)}`),
          (error) =>
            broadcast({ type: "error", message: `accept failed: ${error}` })
        );
    },
    setOffline: (offline) => endpoint?.setOffline(offline),
    connected: () => connected,
    remoteHeads: () => remoteHeads,
  };
}

/**
 * Speak the control protocol on every port handed to `attach`: a dedicated
 * worker's own global scope, or each connecting port of a SharedWorker. The
 * node is built on the first `config` and shared by every port.
 */
export function startNode(): { attach(port: ControlPort): void } {
  const ports = new Set<ControlPort>();
  let node: Promise<Node> | null = null;

  const post = (port: ControlPort, message: NodeMessage) => {
    try {
      port.postMessage(message);
    } catch {}
  };
  const broadcast = (message: NodeMessage) => {
    for (const port of ports) post(port, message);
  };

  async function handle(
    message: TabMessage,
    port: ControlPort,
    event: MessageEvent
  ) {
    switch (message.type) {
      case "config": {
        node ??= build(message.config, broadcast);
        const built = await node;
        post(port, { type: "ready", peerId: built.peerId });
        return;
      }
      case "port": {
        const [channel] = event.ports;
        try {
          (await node!).accept(channel);
          post(port, { type: "port-ready", id: message.id });
        } catch (error) {
          post(port, {
            type: "port-failed",
            id: message.id,
            error: String(error),
          });
        }
        return;
      }
      case "offline":
        (await node!).setOffline(message.offline);
        return;
      case "status": {
        const built = await node!;
        post(port, { type: "connection", connected: built.connected() });
        for (const [documentId, byPeer] of built.remoteHeads()) {
          for (const [storageId, heads] of byPeer) {
            post(port, { type: "remote-heads", documentId, storageId, heads });
          }
        }
        return;
      }
    }
  }

  self.addEventListener("error", (event) => {
    broadcast({ type: "error", message: (event as ErrorEvent).message });
  });
  self.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    broadcast({ type: "error", message: `unhandled rejection: ${reason}` });
  });

  return {
    attach(port) {
      ports.add(port);
      port.addEventListener("message", (event) => {
        void handle(event.data as TabMessage, port, event).catch((error) =>
          post(port, { type: "error", message: String(error) })
        );
      });
      port.start?.();
    },
  };
}
