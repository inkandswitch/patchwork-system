// The Subduction node for a patchwork site, in a SharedWorker: one instance
// serves every tab and lives as long as any tab does.
//
// It holds this origin's storage and the link to the sync server, and nothing
// else — no Repo, no automerge. Tabs and the automerge worker are peers that
// connect over a MessagePort; a bare Subduction node relays their documents,
// edits and ephemeral messages both to each other and to the server.

// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import {
  Subduction,
  WebCryptoSigner,
} from "@automerge/automerge-subduction/slim";
import {
  SubductionStorageBridge,
  WebSocketTransport,
  encodeHeads,
  toDocumentId,
} from "@automerge/automerge-repo/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import type { SyncServerSelection } from "@automerge/automerge-repo-keyhive";

import {
  MessagePortTransport,
  WORKER_SUBDUCTION_SERVICE,
} from "./worker-link.js";
import { startWorkerControl, postToPort } from "./worker-control.js";
import {
  SYNCSTATE_CHANNEL,
  type SyncStateBroadcast,
  type SyncStateDocMessage,
  type SyncStateRequestMessage,
} from "./types.js";

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: SyncServerSelection;
};

const syncServer =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEADS_SCAN_INTERVAL_MS = 3_000;
const RESYNC_REVIEW_INTERVAL_MS = 5_000;
const RESYNC_GRACE_MS = 8_000;
const RESYNC_INITIAL_DELAY_MS = 5_000;
const RESYNC_MAX_DELAY_MS = 60_000;

const control = startWorkerControl("subduction-worker", {
  onMessage: handleControlMessage,
  onClose: (port) => syncWatchers.delete(port),
});
const log = control.log;

type Identity = { peerId: string; verifyingKey: string };

let identity: Identity | undefined;
let serverPeerIds: string[] = [];
let connected = false;

// ── The node ───────────────────────────────────────────────────────────

let nodePromise: Promise<Subduction> | null = null;

function getSubduction(): Promise<Subduction> {
  if (!nodePromise) {
    nodePromise = start();
    // Don't cache a rejection (e.g. the wasm fetch failed): clear the slot so
    // the next caller retries from scratch.
    nodePromise.catch(() => {
      nodePromise = null;
    });
  }
  return nodePromise;
}

async function start(): Promise<Subduction> {
  log("fetching wasm");
  const wasm = await fetch("/subduction.wasm").then((r) => r.arrayBuffer());
  initSubductionSync(new Uint8Array(wasm));
  log("wasm initialized");

  const signer = await WebCryptoSigner.setup();
  identity = {
    peerId: signer.peerId().toString(),
    verifyingKey: (
      signer.verifyingKey() as Uint8Array<ArrayBufferLike> & {
        toHex(): string;
      }
    ).toHex(),
  };

  const subduction = new Subduction({
    signer: signer as never,
    storage: new SubductionStorageBridge(
      new IndexedDBWorkerStorageAdapter()
    ) as never,
    onRemoteHeads: (
      sedimentreeId: { toString(): string; toBytes(): Uint8Array },
      remotePeerId: { toString(): string },
      heads: Array<{ toHexString(): string }>
    ) => {
      recordHeads(
        toDocumentId(sedimentreeId as never),
        remotePeerId.toString(),
        // bs58check-encoded to match automerge-repo's UrlHeads format, which
        // is what a tab compares against its own heads.
        [...encodeHeads(heads.map((head) => head.toHexString()) as never)],
        Date.now()
      );
    },
  });

  (self as any).subduction = subduction;
  (self as any).syncIdentity = identity;
  console.log("[patchwork] subduction identity:", identity);

  postWhoAmI();
  void serverLoop(subduction);
  setInterval(() => void scanOwnHeads(subduction), HEADS_SCAN_INTERVAL_MS);
  setInterval(() => void reviewResync(subduction), RESYNC_REVIEW_INTERVAL_MS);

  return subduction;
}

/** Reconnect loop for the sync server. */
async function serverLoop(subduction: Subduction): Promise<void> {
  const service = new URL(syncServer.url).host;
  let backoff = RECONNECT_BASE_MS;

  for (;;) {
    let transport: WebSocketTransport | null = null;
    try {
      transport = await WebSocketTransport.connect(syncServer.url);
      const peerId = await subduction.connectTransport(transport, service);
      serverPeerIds = [peerId.toString()];
      connected = true;
      postConnection();
      log("connected to", syncServer.url);
      backoff = RECONNECT_BASE_MS;
      await transport.closed();
      log("disconnected from", syncServer.url);
    } catch (error) {
      console.warn(`[subduction-worker] ${syncServer.url} failed:`, error);
      void transport?.disconnect().catch(() => {});
    }
    connected = false;
    postConnection();
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

// ── Tab and worker links ───────────────────────────────────────────────

/**
 * Resolves once this port is being read, which is all the ack means and all
 * the far side can wait for: `acceptTransport` is the responder half of the
 * handshake, so it doesn't settle until the other end initiates — and the
 * other end doesn't initiate until it has the ack.
 */
async function acceptPort(port: MessagePort): Promise<void> {
  const subduction = await getSubduction();
  void subduction
    .acceptTransport(new MessagePortTransport(port), WORKER_SUBDUCTION_SERVICE)
    .then(
      () => log("accepted a peer"),
      (error) => console.error("accepting a peer failed", error)
    );
}

function handleControlMessage(
  data: any,
  controlPort: MessagePort,
  event: MessageEvent
): void {
  switch (data?.type) {
    case "port": {
      const [port] = event.ports;
      acceptPort(port).then(
        () => postToPort(controlPort, { type: "port-ready", id: data.id }),
        (error) => {
          console.error("accepting a peer failed", error);
          // Tell the tab so it doesn't hang until its timeout.
          postToPort(controlPort, {
            type: "port-failed",
            id: data.id,
            error: String(error),
          });
        }
      );
      return;
    }

    case "sync-sub":
      if (typeof data.documentId === "string") {
        syncSubscribe(controlPort, data.documentId);
      }
      return;

    case "sync-unsub":
      if (typeof data.documentId === "string") {
        syncWatchers.get(controlPort)?.delete(data.documentId);
      }
      return;
  }
}

// ── Sync state ─────────────────────────────────────────────────────────
// Only this worker talks to the sync server, so it is the only place that
// learns the server's heads and whether the link is up. Global signals go out
// on SYNCSTATE_CHANNEL so any tab can render an indicator; per-document heads
// are addressed to the tabs that asked for that document.

type PeerHeads = { heads: string[]; timestamp: number };
/** documentId -> peer (storageId) -> last-known heads */
const snapshot = new Map<string, Map<string, PeerHeads>>();
const syncWatchers = new Map<MessagePort, Set<string>>();
const channel = new BroadcastChannel(SYNCSTATE_CHANNEL);

type ResyncEntry = {
  serverSig: string;
  since: number;
  delay: number;
  lastResyncAt: number;
};
const resyncing = new Map<string, ResyncEntry>();

function syncSubscribe(port: MessagePort, documentId: string): void {
  let docs = syncWatchers.get(port);
  if (!docs) syncWatchers.set(port, (docs = new Set()));
  if (docs.has(documentId)) return;
  docs.add(documentId);
  for (const [storageId, { heads, timestamp }] of snapshot.get(documentId) ??
    []) {
    postToPort(port, {
      type: "sync-state",
      documentId,
      storageId,
      heads,
      timestamp,
    } satisfies SyncStateDocMessage);
  }
}

function recordHeads(
  documentId: string,
  storageId: string,
  heads: string[],
  timestamp: number
): void {
  let byStorage = snapshot.get(documentId);
  if (!byStorage) snapshot.set(documentId, (byStorage = new Map()));
  byStorage.set(storageId, { heads, timestamp });
  const message: SyncStateDocMessage = {
    type: "sync-state",
    documentId,
    storageId,
    heads,
    timestamp,
  };
  for (const [port, docs] of syncWatchers) {
    if (docs.has(documentId)) postToPort(port, message);
  }
}

function postWhoAmI(): void {
  if (!identity) return;
  channel.postMessage({
    type: "whoami",
    peerId: identity.peerId,
    verifyingKey: identity.verifyingKey,
  } satisfies SyncStateBroadcast);
}

function postConnection(): void {
  channel.postMessage({
    type: "connection",
    connected,
    serverPeerIds,
  } satisfies SyncStateBroadcast);
}

// A BroadcastChannel never receives its own posts, so this only sees tabs'
// requests. Only the global signals are replayed; a tab gets per-doc heads by
// subscribing.
channel.addEventListener("message", (event: MessageEvent) => {
  if ((event.data as SyncStateRequestMessage)?.type !== "request") return;
  postWhoAmI();
  postConnection();
});

/** Advertise our own heads for every document we hold. */
async function scanOwnHeads(subduction: Subduction): Promise<void> {
  if (!identity) return;
  const now = Date.now();
  for (const entry of await subduction.getAllHeads()) {
    recordHeads(
      toDocumentId(entry.id as never),
      identity.peerId,
      [...encodeHeads(entry.heads.map((head) => head.toHexString()) as never)],
      now
    );
  }
}

/**
 * Nudge documents the server has moved past. Both sides' heads here are
 * sedimentree commit ids, so they compare directly — unlike a document's
 * Automerge frontier, which is a different thing entirely.
 */
async function reviewResync(subduction: Subduction): Promise<void> {
  if (!identity || !connected) {
    resyncing.clear();
    return;
  }
  const now = Date.now();

  for (const [documentId, byStorage] of snapshot) {
    const ours = new Set(byStorage.get(identity.peerId)?.heads ?? []);
    const serverHeads = new Set<string>();
    for (const [storageId, entry] of byStorage) {
      if (serverPeerIds.includes(storageId)) {
        for (const head of entry.heads) serverHeads.add(head);
      }
    }
    if (serverHeads.size === 0) {
      resyncing.delete(documentId);
      continue;
    }
    if ([...serverHeads].every((head) => ours.has(head))) {
      resyncing.delete(documentId);
      continue;
    }

    // Behind. Key the grace timer on the server's heads alone, so our own
    // edits churning don't keep resetting it.
    const serverSig = [...serverHeads].sort().join(",");
    const previous = resyncing.get(documentId);
    if (!previous || previous.serverSig !== serverSig) {
      resyncing.set(documentId, {
        serverSig,
        since: now,
        delay: RESYNC_INITIAL_DELAY_MS,
        lastResyncAt: 0,
      });
      continue;
    }
    if (now - previous.since < RESYNC_GRACE_MS) continue;
    if (now - previous.lastResyncAt < previous.delay) continue;

    log("re-syncing behind doc", documentId);
    previous.lastResyncAt = now;
    previous.delay = Math.min(previous.delay * 2, RESYNC_MAX_DELAY_MS);
    for (const peerId of serverPeerIds) {
      try {
        await subduction.fullSyncWithPeer(peerId as never, true);
      } catch (error) {
        log("fullSyncWithPeer failed", error);
      }
    }
  }
}

// Start booting now rather than on the first port: wasm and storage hydration
// are the slow part, and a tab connects within milliseconds of spawning us.
void getSubduction();
