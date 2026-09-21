// A subduction node for a worker. A Repo with this origin's IndexedDB, a
// socket to the sync server and (optionally) a BroadcastChannel mesh to the
// other nodes on the origin. It never opens a document itself: tabs are
// storageless Repos that reach it over MessagePorts and sync through it.
import {
  initializeWasm,
  Repo,
  WebSocketTransport,
  type ManagedTransport,
  type PeerId,
  type WebSocketEndpointInterface,
} from "@automerge/automerge-repo/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
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

/**
 * The server socket, observable and switchable. automerge-repo's reconnect
 * loop calls `connect()`; while offline it waits there, so nothing reconnects
 * until told to.
 */
class ServerEndpoint implements WebSocketEndpointInterface {
  #live: WebSocketTransport | null = null;
  #offline = false;
  #wake: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly events: { onOpen(): void; onClosed(): void }
  ) {}

  async connect(): Promise<ManagedTransport> {
    while (this.#offline) {
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    const transport = await WebSocketTransport.connect(this.url);
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
    else {
      this.#wake?.();
      this.#wake = null;
    }
  }
}

type Node = {
  peerId: string;
  accept(port: MessagePort): void;
  setOffline(offline: boolean): void;
  connected(): boolean;
  serverHeads(): Map<string, string[]>;
};

async function build(
  config: NodeConfig,
  broadcast: (message: NodeMessage) => void
): Promise<Node> {
  const [automergeWasm, subductionWasm] = await Promise.all([
    fetch("/automerge.wasm").then((r) => r.bytes()),
    fetch("/subduction.wasm").then((r) => r.bytes()),
  ]);
  await initializeWasm(automergeWasm);
  initSubductionSync(subductionWasm);

  const signer = new MemorySigner();
  const serverHeads = new Map<string, string[]>();
  let socketOpen = false;
  let connected = false;
  const setConnected = (value: boolean) => {
    if (value === connected) return;
    connected = value;
    broadcast({ type: "connection", connected });
  };

  const endpoint =
    config.server === "none"
      ? null
      : new ServerEndpoint(config.server, {
          onOpen() {
            socketOpen = true;
            void awaitHandshake();
          },
          onClosed() {
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

  repo.on("subduction-remote-heads", ({ documentId, storageId, heads }) => {
    if (storageId !== config.serverPeer) return;
    serverHeads.set(documentId, [...heads]);
    broadcast({ type: "remote-heads", documentId, heads: [...heads] });
  });

  // The socket being open is not the handshake being done; the server counts
  // as connected once it shows up among the peers.
  async function awaitHandshake() {
    while (socketOpen && !connected) {
      const peers = await repo.connectedSubductionPeerIds();
      if (config.serverPeer && peers.includes(config.serverPeer)) {
        setConnected(true);
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
        .catch((error) =>
          broadcast({ type: "error", message: `accept failed: ${error}` })
        );
    },
    setOffline: (offline) => endpoint?.setOffline(offline),
    connected: () => connected,
    serverHeads: () => serverHeads,
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
        for (const [documentId, heads] of built.serverHeads()) {
          post(port, { type: "remote-heads", documentId, heads });
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
