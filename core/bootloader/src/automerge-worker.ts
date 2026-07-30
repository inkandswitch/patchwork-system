// The automerge repo for a patchwork site, in a SharedWorker: one instance
// serves every tab and lives as long as any tab does.
//
// The service worker holds no repo. When it misses the cache for a request that
// looks like a URL encoded URL, it broadcasts a HandoffRequestMessage on
// HANDOFF_CHANNEL; we resolve the automerge URL, write the response into the
// service worker's cache (keyed by a Request reconstructed to match the one
// it's holding), and reply on the same channel.
import { initializeWasm, hasHeads } from "@automerge/automerge/slim";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { WebCryptoSigner } from "@automerge/automerge-subduction/slim";
import { makePortProvider } from "@automerge/automerge-repo/worker-port";

import {
  Repo,
  WorkerWebSocketEndpoint,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type PeerId,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { resolvePath } from "@inkandswitch/patchwork-filesystem";

import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket";
import {
  initializeAutomergeRepoKeyhiveRustWithRepo,
  initKeyhiveWasm,
  type AutomergeRepoKeyhiveRust,
  type SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";

import { DEFAULT_CLASSIC_SYNC_SERVER } from "./sync-config.js";
import { keyhiveStorageName, storagePrefix } from "./storage.js";
import {
  HANDOFF_CHANNEL,
  SYNCSTATE_CHANNEL,
  type HandoffCachedMessage,
  type HandoffOnlineMessage,
  type HandoffRequest,
  type HandoffAbortMessage,
  type HandoffRequestMessage,
  type HandoffResponseMessage,
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

const RESOLVE_TIMEOUT_MS = 30_000;

const CACHEABLE_STATUSES = [200, 203, 204];

// A fresh instance means a new repo peerId and cold in-memory state, so a tab
// seeing a changed id knows to re-subscribe. Sent in `hello` and every `pong`.
const WORKER_INSTANCE_ID = Math.random().toString(36).slice(2);
const WORKER_BOOT_TIME = Date.now();

type Identity = { peerId: string; verifyingKey: string };

// `debug` reads localStorage, which a SharedWorker doesn't have, so debugging is
// toggled by a control message from a tab instead.
let debugging = false;
function log(...args: any[]) {
  if (debugging) console.log("[automerge-worker]", ...args);
}

// ── Console forwarding ─────────────────────────────────────────────────
// The SharedWorker's own console is buried in chrome://inspect, so mirror
// everything over each connected tab's control port.

const controlPorts = new Set<MessagePort>();
// Logs emitted before any tab connects (wasm boot) would otherwise be lost.
const preConnectBuffer: Array<{ level: string; args: string[] }> = [];
const MAX_BUFFER = 200;

function serializeArg(arg: any): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function postToPort(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(`sending failed`, error);
  }
}

function forwardToMainThread(level: string, rawArgs: any[]) {
  const args = rawArgs.map(serializeArg);
  if (!controlPorts.size) {
    if (preConnectBuffer.length < MAX_BUFFER)
      preConnectBuffer.push({ level, args });
    return;
  }
  for (const port of controlPorts) {
    postToPort(port, { type: "console", level, args });
  }
}

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: any[]) => {
    original(...args);
    forwardToMainThread(level, args);
  };
}

self.addEventListener("error", (event) => {
  const e = event as ErrorEvent;
  forwardToMainThread("error", [
    `uncaught error: ${e.message}`,
    e.error instanceof Error ? e.error.stack : undefined,
  ]);
});

self.addEventListener("unhandledrejection", (event) => {
  const reason = (event as PromiseRejectionEvent).reason;
  forwardToMainThread("error", [
    "unhandled rejection:",
    reason instanceof Error ? reason.stack || reason.message : reason,
  ]);
});

console.warn(
  `[lifecycle] automerge SharedWorker started (instance ${WORKER_INSTANCE_ID})`
);

const WATCHDOG_TICK_MS = 5_000;
let watchdogLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - watchdogLast;
  watchdogLast = now;
  if (gap > WATCHDOG_TICK_MS * 2) {
    console.warn(
      `[lifecycle] watchdog timer gap ~${Math.round(gap / 1000)}s ` +
        `(expected every ${WATCHDOG_TICK_MS / 1000}s)`
    );
  }
}, WATCHDOG_TICK_MS);

// ── Per-tab sync-state subscriptions ───────────────────────────────────
// A tab's control port subscribes to the documents it cares about and we push
// only those docs' heads down that port, so tab A never sees tab B's docs. A
// port's whole subscription set is dropped when it closes, so there's nothing
// to reference-count or time out.

const syncWatchers = new Map<MessagePort, Set<string>>();

// Set once the repo's snapshot exists, so a `sync-sub` arriving during boot can
// be replayed the doc's current heads as soon as it does.
let replaySyncForPort:
  ((documentId: string, port: MessagePort) => void) | null = null;

function syncSubscribe(port: MessagePort, documentId: string): void {
  let docs = syncWatchers.get(port);
  if (!docs) syncWatchers.set(port, (docs = new Set()));
  if (docs.has(documentId)) return;
  docs.add(documentId);
  replaySyncForPort?.(documentId, port);
}

function syncUnsubscribe(port: MessagePort, documentId: string): void {
  syncWatchers.get(port)?.delete(documentId);
}

function pushSyncState(message: SyncStateDocMessage): void {
  for (const [port, docs] of syncWatchers) {
    if (docs.has(message.documentId)) postToPort(port, message);
  }
}

const subductionPortProvider = makePortProvider();

// Memoized so a construction retry reuses the endpoint instead of leaking one
// per attempt.
let subductionEndpoints: WorkerWebSocketEndpoint[] | null = null;
function getSubductionEndpoints(): WorkerWebSocketEndpoint[] {
  return (subductionEndpoints ??= [
    new WorkerWebSocketEndpoint(syncServer.url, {
      worker: subductionPortProvider.source,
    }),
  ]);
}

type RepoHive = { repo: Repo; hive?: AutomergeRepoKeyhiveRust };
type BuiltRepo = RepoHive & { identity?: Identity };

let repoHivePromise: Promise<RepoHive> | null = null;

function getRepoHive(): Promise<RepoHive> {
  if (!repoHivePromise) {
    repoHivePromise = setUpRepoHive();
    // Don't permanently cache a rejection (e.g. the wasm fetch failed) — clear
    // the slot so the next caller retries from scratch.
    repoHivePromise.catch(() => {
      repoHivePromise = null;
    });
  }
  return repoHivePromise;
}

async function setUpRepoHive(): Promise<RepoHive> {
  log("fetching wasm");
  const [automergeWasm, subductionWasm] = await Promise.all([
    fetch("/automerge.wasm").then((r) => r.arrayBuffer()),
    fetch("/subduction.wasm").then((r) => r.arrayBuffer()),
  ]);
  initSubductionSync(new Uint8Array(subductionWasm));
  await initializeWasm(new Uint8Array(automergeWasm));
  log("wasm initialized");

  const built: BuiltRepo = syncServer.keyhive
    ? await buildKeyhiveRepo(syncServer.keyhive)
    : await buildPlainRepo();

  (self as any).repo = built.repo;
  if (built.hive) (self as any).hive = built.hive;
  if (built.identity) (self as any).syncIdentity = built.identity;

  setUpSyncStateBroadcast(built.repo, built.identity);

  // Deliberately not awaited: the network subsystem starts with only the
  // subduction adapter, and the MessageChannel adapter is added later by
  // connectPort, which itself awaits getRepoHive. Blocking here would deadlock
  // that path and starve the handoff handler.
  built.repo.networkSubsystem
    .whenReady()
    .then(() => log("repo network subsystem ready"));

  return { repo: built.repo, hive: built.hive };
}

async function buildPlainRepo(): Promise<BuiltRepo> {
  const signer = await WebCryptoSigner.setup();
  const identity = {
    peerId: signer.peerId().toString(),
    verifyingKey: (
      signer.verifyingKey() as Uint8Array<ArrayBufferLike> & {
        toHex(): string;
      }
    ).toHex(),
  };
  const repo = new Repo({
    storage: new IndexedDBWorkerStorageAdapter(),
    signer,
    peerId: `automerge-worker-${Math.random().toString(36).slice(2)}` as PeerId,
    async sharePolicy(peerId) {
      return peerId.includes("storage-server");
    },
    enableRemoteHeadsGossiping: true,
    subductionWebsocketEndpoints: getSubductionEndpoints(),
  });
  console.log("[patchwork] shared-worker subduction identity:", identity);
  return { repo, identity };
}

async function buildKeyhiveRepo(
  keyhiveSyncServer: SyncServerSelection
): Promise<BuiltRepo> {
  initKeyhiveWasm();
  const { hive, repo } = await initializeAutomergeRepoKeyhiveRustWithRepo({
    createRepo: (config) => new Repo(config),
    storage: new IndexedDBWorkerStorageAdapter(keyhiveStorageName),
    peerIdSuffix:
      `${storagePrefix}-worker` + Math.random().toString(36).slice(2),
    automaticArchiveIngestion: true,
    cachingMode: "periodic",
    // ARK selects the relay via `syncServer`, which pairs the contact card with
    // the matching peer id. Omitting it defaults to "subduction".
    syncServer: keyhiveSyncServer,
    repo: {
      storage: new IndexedDBWorkerStorageAdapter(),
      subductionWebsocketEndpoints: getSubductionEndpoints(),
      enableRemoteHeadsGossiping: true,
    },
  });

  hive.networkAdapter.whenReady().then(() => {
    (hive.networkAdapter as any).syncKeyhive();
  });

  return { repo, hive };
}

// ── Classic sync ───────────────────────────────────────────────────────

let classicSyncServer = DEFAULT_CLASSIC_SYNC_SERVER;
let classicSyncAdapter: WebSocketWorkerClientAdapter | null = null;
let classicSyncConnect: Promise<void> | null = null;

function connectClassicSyncNetwork(server: string): Promise<void> {
  const url = server.trim() || DEFAULT_CLASSIC_SYNC_SERVER;
  if (classicSyncConnect && classicSyncServer === url)
    return classicSyncConnect;

  if (classicSyncAdapter && classicSyncServer !== url) {
    classicSyncAdapter.disconnect();
    classicSyncAdapter = null;
  }

  classicSyncServer = url;
  const connecting = (async () => {
    const { repo } = await getRepoHive();
    if (!classicSyncAdapter) {
      classicSyncAdapter = new WebSocketWorkerClientAdapter(url);
      repo.networkSubsystem.addNetworkAdapter(classicSyncAdapter);
    }
    await classicSyncAdapter.whenReady();
    log("classic sync connected", url);
  })();

  // Clear the memo on failure so a later attempt can retry, and swallow the
  // rejection on this copy so it isn't reported as unhandled — callers get it
  // from the promise we return.
  classicSyncConnect = connecting;
  connecting.catch(() => {
    if (classicSyncConnect === connecting) classicSyncConnect = null;
  });
  return connecting;
}

// ── Sync-state broadcast ───────────────────────────────────────────────
// Only this worker is connected to the sync server, so it's the only place that
// learns the server's heads ("subduction-remote-heads", keyed by each Subduction
// peer's verifying-key storageId) and whether the link is up
// ("subduction-connection"). Global signals go out on SYNCSTATE_CHANNEL so any
// tab can render a sync indicator; per-document heads are addressed to
// subscribers instead (see pushSyncState).

const RESYNC_GRACE_MS = 8_000; // must be stably diverged this long first
const RESYNC_INITIAL_DELAY_MS = 5_000;
const RESYNC_MAX_DELAY_MS = 60_000;
const RESYNC_REVIEW_INTERVAL_MS = 5_000;
const OWN_HANDLE_SCAN_INTERVAL_MS = 3_000;

type PeerHeads = { heads: string[]; timestamp: number };
type ResyncEntry = {
  serverSig: string;
  since: number;
  delay: number;
  lastResyncAt: number;
};

type SyncState = {
  repo: Repo;
  channel: BroadcastChannel;
  identity?: Identity;
  /** documentId -> storageId (verifying key) -> last-known heads */
  snapshot: Map<string, Map<string, PeerHeads>>;
  connected: boolean;
  /** Directly-connected sync-server peer ids, used to judge "synced". */
  serverPeerIds: string[];
  tracked: Set<string>;
  resync: Map<string, ResyncEntry>;
};

type OwnHandle = {
  documentId: string;
  heads: () => string[];
  on: (ev: "heads-changed", cb: () => void) => void;
};

let syncStateWired = false;

function setUpSyncStateBroadcast(repo: Repo, identity?: Identity): void {
  if (syncStateWired) return;
  syncStateWired = true;

  const state: SyncState = {
    repo,
    channel: new BroadcastChannel(SYNCSTATE_CHANNEL),
    identity,
    snapshot: new Map(),
    connected: repo.isSubductionConnected(),
    serverPeerIds: [],
    tracked: new Set(),
    resync: new Map(),
  };

  postWhoAmI(state);

  replaySyncForPort = (documentId, port) => replayDoc(state, documentId, port);
  for (const [port, docs] of syncWatchers) {
    for (const documentId of docs) replayDoc(state, documentId, port);
  }

  repo.on(
    "subduction-remote-heads",
    ({ documentId, storageId, heads, timestamp }) => {
      recordHeads(state, documentId, storageId, [...heads], timestamp);
      // A doc the server reported is one we hold, so advertise our heads for it
      // too. Only this doc: a full scan per event is O(all handles) and goes
      // quadratic during sync bursts. The tick covers general discovery.
      const handle = repo.handles[documentId as DocumentId];
      if (handle) trackOwnHandle(state, handle as never);
      reviewResync(state, documentId);
    }
  );

  repo.on("subduction-connection", ({ connected }) => {
    state.connected = connected;
    postConnection(state);
    if (connected) void refreshServerPeers(state);
  });

  // A BroadcastChannel never receives its own posts, so this only sees tabs'
  // requests. Only the global signals are replayed; a late tab gets per-doc
  // heads by subscribing.
  state.channel.addEventListener("message", (event: MessageEvent) => {
    if ((event.data as SyncStateRequestMessage)?.type !== "request") return;
    postWhoAmI(state);
    postConnection(state);
  });

  void refreshServerPeers(state);
  scanOwnHandles(state);

  if (!identity) return;
  // Subduction-pushed docs don't surface via the "document" event, so discover
  // them by re-scanning repo.handles on a tick.
  setInterval(() => scanOwnHandles(state), OWN_HANDLE_SCAN_INTERVAL_MS);
  // The "stuck" case is precisely when no head events are firing, so the
  // grace/backoff timers can only advance on a tick.
  setInterval(() => reviewAllResync(state), RESYNC_REVIEW_INTERVAL_MS);
}

function postWhoAmI(state: SyncState): void {
  if (!state.identity) return;
  state.channel.postMessage({
    type: "whoami",
    peerId: state.identity.peerId,
    verifyingKey: state.identity.verifyingKey,
  } satisfies SyncStateBroadcast);
}

function postConnection(state: SyncState): void {
  state.channel.postMessage({
    type: "connection",
    connected: state.connected,
    serverPeerIds: state.serverPeerIds,
  } satisfies SyncStateBroadcast);
}

function recordHeads(
  state: SyncState,
  documentId: string,
  storageId: string,
  heads: string[],
  timestamp: number
): void {
  let byStorage = state.snapshot.get(documentId);
  if (!byStorage) state.snapshot.set(documentId, (byStorage = new Map()));
  byStorage.set(storageId, { heads, timestamp });
  pushSyncState({
    type: "sync-state",
    documentId,
    storageId,
    heads,
    timestamp,
  });
}

function replayDoc(
  state: SyncState,
  documentId: string,
  port: MessagePort
): void {
  const byStorage = state.snapshot.get(documentId);
  if (!byStorage) return;
  for (const [storageId, { heads, timestamp }] of byStorage) {
    postToPort(port, {
      type: "sync-state",
      documentId,
      storageId,
      heads,
      timestamp,
    } satisfies SyncStateDocMessage);
  }
}

/** The peer list is empty until the handshake finishes, so retry briefly. */
async function refreshServerPeers(state: SyncState): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const ids = await state.repo.connectedSubductionPeerIds();
      if (ids.length > 0) {
        state.serverPeerIds = ids;
        postConnection(state);
        return;
      }
    } catch {
      // No subduction source yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Advertise this worker's own heads for every doc it holds, so the worker hop is
// visible on every document. No-op on the keyhive path, which has no identity.

function broadcastOwnHeads(state: SyncState, handle: OwnHandle): void {
  if (!state.identity) return;
  let heads: string[];
  try {
    heads = [...handle.heads()];
  } catch {
    return; // handle not ready
  }
  recordHeads(
    state,
    handle.documentId,
    state.identity.peerId,
    heads,
    Date.now()
  );
  reviewResync(state, handle.documentId);
}

function trackOwnHandle(state: SyncState, handle: OwnHandle): void {
  if (!state.identity || state.tracked.has(handle.documentId)) return;
  state.tracked.add(handle.documentId);
  handle.on("heads-changed", () => broadcastOwnHeads(state, handle));
  broadcastOwnHeads(state, handle);
}

function scanOwnHandles(state: SyncState): void {
  if (!state.identity) return;
  for (const handle of Object.values(state.repo.handles)) {
    trackOwnHandle(state, handle as never);
  }
}

function serverHeadsFor(state: SyncState, documentId: string): UrlHeads {
  const byStorage = state.snapshot.get(documentId);
  if (!byStorage) return [] as unknown as UrlHeads;
  const heads = new Set<string>();
  for (const [storageId, entry] of byStorage) {
    if (state.serverPeerIds.includes(storageId)) {
      for (const head of entry.heads) heads.add(head);
    }
  }
  return [...heads] as UrlHeads;
}

function reviewResync(state: SyncState, documentId: string): void {
  if (!state.identity || !state.connected) {
    state.resync.delete(documentId);
    return;
  }
  const handle = state.repo.handles[documentId as DocumentId];
  if (!handle) return;

  const serverHeads = serverHeadsFor(state, documentId);
  if (serverHeads.length === 0) {
    state.resync.delete(documentId); // nothing to compare against
    return;
  }

  // The server advertises subduction sedimentree heads (loose-commit and
  // fragment-boundary commit ids), which are NOT the Automerge frontier, so
  // never compare them to handle.heads() for equality. Ask instead whether we
  // already hold every commit the server advertises.
  let haveAll: boolean;
  try {
    haveAll = handle.containsHeads(serverHeads);
  } catch {
    return; // doc not ready, or an undecodable head
  }
  if (haveAll) {
    state.resync.delete(documentId);
    return;
  }

  // Behind. Key the grace timer on the server heads alone, so your own edits
  // churning don't keep resetting it.
  const serverSig = [...serverHeads].sort().join(",");
  const now = Date.now();
  const prev = state.resync.get(documentId);
  if (!prev || prev.serverSig !== serverSig) {
    // First sighting, or the server made progress: restart the clock.
    state.resync.set(documentId, {
      serverSig,
      since: now,
      delay: RESYNC_INITIAL_DELAY_MS,
      lastResyncAt: 0,
    });
    return;
  }
  if (now - prev.since < RESYNC_GRACE_MS) return;
  if (now - prev.lastResyncAt < prev.delay) return;

  log("re-syncing behind doc", documentId);
  try {
    state.repo.resyncSubduction(documentId as DocumentId);
  } catch (e) {
    log("resyncSubduction failed", e);
  }
  prev.lastResyncAt = now;
  prev.delay = Math.min(prev.delay * 2, RESYNC_MAX_DELAY_MS);
}

function reviewAllResync(state: SyncState): void {
  if (!state.identity) return;
  for (const documentId of state.snapshot.keys())
    reviewResync(state, documentId);
  for (const id of [...state.resync.keys()]) {
    if (!state.snapshot.has(id)) state.resync.delete(id);
  }
}

// ── Tab connections ────────────────────────────────────────────────────
// Each tab connects with a control port and opens repo MessageChannel ports
// through it. `adapter` is what was registered with the network subsystem (the
// MessageChannel adapter, or the keyhive wrapper around it); `mcAdapter` is
// always the underlying MessageChannel adapter, so the port itself can be
// disconnected.

type RepoChannel = {
  adapter: { disconnect(): void };
  mcAdapter: MessageChannelNetworkAdapter;
  port: MessagePort;
};
type Connection = { channels: Set<RepoChannel> };

function dropRepoChannel(repo: Repo, channel: RepoChannel) {
  // removeNetworkAdapter pulls the adapter out of networkSubsystem.adapters and
  // calls disconnect(), which for the MessageChannel adapter emits the
  // close/peer-disconnected events that clear #adaptersByPeer.
  try {
    repo.networkSubsystem.removeNetworkAdapter(channel.adapter as any);
  } catch (err) {
    console.error("removeNetworkAdapter failed", err);
  }
  // On the keyhive path the registered adapter is a wrapper, so make sure the
  // underlying port is disconnected and closed too.
  try {
    channel.mcAdapter.disconnect();
  } catch {}
  try {
    channel.port.close();
  } catch {}
}

async function dropConnection(connection: Connection) {
  if (!connection.channels.size || !repoHivePromise) return;
  const { repo } = await getRepoHive();
  log(`tab gone — removing ${connection.channels.size} network adapter(s)`);
  for (const channel of connection.channels) dropRepoChannel(repo, channel);
  connection.channels.clear();
}

async function connectPort(port: MessagePort, connection: Connection) {
  const { hive, repo } = await getRepoHive();
  const mcAdapter = new MessageChannelNetworkAdapter(port, {
    useWeakRef: true,
  });

  if (!hive) {
    repo.networkSubsystem.addNetworkAdapter(mcAdapter);
    connection.channels.add({ adapter: mcAdapter, mcAdapter, port });
    return;
  }

  const onlyShareWithHardcodedServerPeerId = false;
  const periodicallyRequestKeyhiveSync = false;
  const adapter = hive.createKeyhiveNetworkAdapter(
    mcAdapter,
    onlyShareWithHardcodedServerPeerId,
    periodicallyRequestKeyhiveSync,
    2000
  );

  adapter.on("message", (msg: any) => {
    if (msg.type !== "sync" && msg.type !== "request") return;
    if (!msg.documentId) return;
    const handle = repo.handles[msg.documentId];
    if (handle && handle.state !== "unavailable") return;
    repo.findWithProgress(`automerge:${msg.documentId}` as AutomergeUrl);
    repo.shareConfigChanged();
  });

  (adapter as any).on("ingest-remote", () => {
    hive.notifySameAgentKeyhiveChange();
    (hive.networkAdapter as any).syncKeyhive?.();
    repo.shareConfigChanged();
  });

  repo.networkSubsystem.addNetworkAdapter(adapter);
  connection.channels.add({ adapter, mcAdapter, port });
}

function handleControlMessage(
  event: MessageEvent,
  controlPort: MessagePort,
  connection: Connection
) {
  const data = event.data;

  switch (data?.type) {
    case "port": {
      log("received repo channel");
      const [repoPort] = event.ports;
      connectPort(repoPort, connection).then(
        () => controlPort.postMessage({ type: "port-ready", id: data.id }),
        (err) => {
          console.error("connectPort failed", err);
          // Tell the tab so it doesn't hang until its timeout.
          controlPort.postMessage({
            type: "port-failed",
            id: data.id,
            error: String(err),
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
        syncUnsubscribe(controlPort, data.documentId);
      }
      return;

    case "debug":
      debugging = data.debug;
      log("automerge worker debugging enabled");
      return;

    case "connect-classic-sync": {
      const [replyPort] = event.ports;
      const server =
        typeof data.server === "string"
          ? data.server
          : DEFAULT_CLASSIC_SYNC_SERVER;
      connectClassicSyncNetwork(server).then(
        () => {
          replyPort?.postMessage({ type: "connect-classic-sync-ready" });
          replyPort?.close();
        },
        (err) => {
          console.error("connectClassicSyncNetwork failed", err);
          replyPort?.postMessage({
            type: "connect-classic-sync-failed",
            error: String(err),
          });
          replyPort?.close();
        }
      );
      return;
    }

    case "ping":
      controlPort.postMessage({
        type: "pong",
        id: data.id,
        instanceId: WORKER_INSTANCE_ID,
      });
      return;
  }
}

self.addEventListener("connect", (event) => {
  const controlPort = (event as MessageEvent).ports[0];
  const connection: Connection = { channels: new Set() };

  controlPort.addEventListener("message", (messageEvent) => {
    handleControlMessage(messageEvent as MessageEvent, controlPort, connection);
  });

  // The tab side runs donatePort; the messages are channel-tagged so they
  // coexist with the control protocol above.
  subductionPortProvider.attachClient(controlPort);

  // Fires when the owning page is destroyed. Browsers without the close event
  // fall back to the adapters' lazy useWeakRef cleanup.
  controlPort.addEventListener("close", () => {
    controlPorts.delete(controlPort);
    syncWatchers.delete(controlPort);
    void dropConnection(connection);
  });

  controlPort.start();

  controlPort.postMessage({
    type: "hello",
    instanceId: WORKER_INSTANCE_ID,
    bootTime: WORKER_BOOT_TIME,
  });

  controlPorts.add(controlPort);
  for (const { level, args } of preConnectBuffer.splice(0)) {
    postToPort(controlPort, { type: "console", level, args });
  }
});

function waitForHeads(
  handle: DocHandle<unknown>,
  hexHeads: string[],
  signal: AbortSignal
): Promise<boolean> {
  if (hasHeads(handle.doc(), hexHeads)) return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = () => {
      handle.off("heads-changed", check);
      signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (!hasHeads(handle.doc(), hexHeads)) return;
      cleanup();
      resolve(true);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    handle.on("heads-changed", check);
    signal.addEventListener("abort", onAbort);
    // The heads may have landed between the check above and subscribing.
    check();
  });
}

/**
 * Thrown instead of returning a Response when the request should fail as a
 * network error rather than resolve to something the caller can memoize.
 * See {@link HandoffAbortMessage}.
 */
class AbortHandoff extends Error {}

async function resolveAutomergeUrl(
  automergeURL: URL,
  signal: AbortSignal
): Promise<Response> {
  const { repo } = await getRepoHive();
  const [maybeAutomergeUrl, ...path] = automergeURL.href.split("/");

  if (!isValidAutomergeUrl(maybeAutomergeUrl)) {
    return new Response("invalid automerge url", { status: 400 });
  }

  if (path.length && !path[path.length - 1]) path.pop();

  const { heads, hexHeads, documentId } = parseAutomergeUrl(maybeAutomergeUrl);

  // todo, maybe a bad idea? maybe we should throw instead of es-module-caching
  // the headless req
  if (!heads) {
    const folder = await repo.find(maybeAutomergeUrl, { signal });
    const url = stringifyAutomergeUrl({ documentId, heads: folder.heads() });
    const location = `/${encodeURIComponent(url)}${path.length ? `/${path.join("/")}` : ""}`;
    return Response.redirect(location, 307);
  }

  const baseHandle = await repo.find(stringifyAutomergeUrl({ documentId }), {
    signal,
  });
  if (!(await waitForHeads(baseHandle, hexHeads ?? [], signal))) {
    throw new AbortHandoff(
      `heads not found for ${maybeAutomergeUrl} within ${RESOLVE_TIMEOUT_MS}ms`
    );
  }

  const resolved = await resolvePath(
    repo,
    baseHandle.view(heads),
    path.map(decodeURIComponent)
  );
  if (!resolved) {
    throw new Error(
      `couldn't resolve ${path.join("/")} in folder at ${maybeAutomergeUrl}`
    );
  }

  const body: BodyInit =
    resolved.content instanceof Uint8Array
      ? (new Uint8Array(resolved.content) as BlobPart)
      : resolved.content;

  return new Response(body, {
    status: 200,
    headers: { "content-type": resolved.type },
  });
}

const handoffChannel = new BroadcastChannel(HANDOFF_CHANNEL);

function replyToHandoff(id: string, status: number, body: string): void {
  handoffChannel.postMessage({
    id,
    type: "response",
    response: { status, body, headers: { "content-type": "text/plain" } },
  } satisfies HandoffResponseMessage);
}

function impatience(limit: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`resolve timeout after ${limit}ms`)),
      limit
    )
  );
}

async function handleHandoffRequest(message: HandoffRequestMessage) {
  const { id, cachename, request } = message;

  let handoff: URL;
  try {
    handoff = new URL(request.handoffURL);
  } catch {
    console.error("couldn't parse handoff url", request);
    replyToHandoff(
      id,
      400,
      `couldn't parse a special url out of ${request.url}`
    );
    return;
  }

  // Other handlers may be listening on the channel for other schemes, so stay
  // quiet rather than clobbering their reply with an error.
  if (handoff.protocol !== "automerge:") {
    log(
      `ignoring handoff ${id} for non-automerge url ${handoff}. not my circus, not my monkeys`
    );
    return;
  }

  let response: Response;
  try {
    log(`resolving handoff ${id} for ${handoff}`);
    const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    response = await Promise.race([
      resolveAutomergeUrl(handoff, signal),
      impatience(RESOLVE_TIMEOUT_MS),
    ]);
  } catch (error) {
    if (error instanceof AbortHandoff) {
      handoffChannel.postMessage({
        id,
        type: "abort",
        reason: error.message,
      } satisfies HandoffAbortMessage);
      return;
    }
    console.error(`error resolving ${request.url}`, error);
    replyToHandoff(
      id,
      557,
      error instanceof Error
        ? `${error.message}\n\n${error.stack}`
        : String(error)
    );
    return;
  }

  try {
    if (!CACHEABLE_STATUSES.includes(response.status)) {
      // Errors, redirects and the like go back inline for the service worker to
      // serve directly, so they aren't cached forever (still in esmodulecache,
      // cleared after a refresh)
      log(`responding inline to ${request.url} with ${response.status}`);
      handoffChannel.postMessage({
        id,
        type: "response",
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: response.body ? await response.text() : undefined,
        },
      } satisfies HandoffResponseMessage);
      return;
    }

    // Reconstruct the request the service worker is holding so the entry matches
    // its cache.match. `destination` isn't constructible but doesn't participate
    // in cache matching.
    const cacheKey = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      referrer: request.referrer,
    });
    const cache = await caches.open(cachename);
    await cache.put(cacheKey, response);
    log(`cached ${cacheKey.url} in ${cachename}`);
    handoffChannel.postMessage({
      id,
      type: "cached",
    } satisfies HandoffCachedMessage);
  } catch (error) {
    console.error(`failed to reply for ${request.url}`, error);
    replyToHandoff(id, 558, String(error));
  }
}

handoffChannel.addEventListener("message", (event) => {
  if (event.data?.type === "request") {
    void handleHandoffRequest(event.data as HandoffRequestMessage);
  }
});

// Announce ourselves so the service worker can re-broadcast handoff requests
// sent while we were booting.
handoffChannel.postMessage({ type: "online" } satisfies HandoffOnlineMessage);
