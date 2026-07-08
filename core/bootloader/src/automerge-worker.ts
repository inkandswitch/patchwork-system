// The automerge repo for a patchwork site. This runs in a SharedWorker, so
// one instance serves every tab and lives exactly as long as any tab does —
// no keepalive pings, no idle teardown.
//
// The service worker holds no repo. When it misses the cache for a special
// URL it broadcasts a HandoffRequestMessage on HANDOFF_CHANNEL; we resolve
// the automerge URL, write the response into the service worker's cache
// (keyed by a Request reconstructed to match the one it's holding), and
// reply on the same channel.

// Heavy imports — marked external by the service-worker vite plugin,
// resolved to /packages/... URLs at build time. The worker is created with
// type:"module" so the browser fetches these as regular network requests.
// Uses /slim so wasm is fetched from /automerge.wasm (emitted by the vite
// plugin) instead of bundling the ~3MB base64 string.
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
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { resolvePath } from "@inkandswitch/patchwork-filesystem";

// Small adapters — bundled directly into the worker
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket";
import {
  initializeAutomergeRepoKeyhive,
  type AutomergeRepoKeyhive,
} from "@automerge/automerge-repo-keyhive";

import {
  HANDOFF_CHANNEL,
  SYNCSTATE_CHANNEL,
  type HandoffCachedMessage,
  type HandoffOnlineMessage,
  type HandoffRequest,
  type HandoffRequestMessage,
  type HandoffResponseMessage,
  type SyncStateBroadcast,
  type SyncStateDocMessage,
  type SyncStateRequestMessage,
} from "./types.js";

declare const __SITE_NAME__: string;
declare const __KEYHIVE__: boolean;
declare const __KEYHIVE_SYNC_SERVER__: boolean;

let debugging = false;

// Per-boot identity so a tab can detect a worker *restart*: a fresh instance
// means a new repo peerId + cold in-memory state, so the tab's docs must be
// re-subscribed. Sent in `hello` (on connect) and every `pong`.
const WORKER_INSTANCE_ID = Math.random().toString(36).slice(2);
const WORKER_BOOT_TIME = Date.now();

// ── Forward console output + uncaught errors to the main thread ─────────
// The SharedWorker has its own console that's a pain to find (chrome://inspect
// → shared workers). Patch console.* and the global error handlers to also
// post back over every connected tab's control port, tagged [automerge-worker].

const controlPorts = new Set<MessagePort>();

// ── Keepalive-drift probe (bench instrumentation) ───────────────────────
// Measures how late a 1s timer fires on this thread — i.e. how late an
// in-thread keepalive would be under sync/wasm load. Cheap (one Date.now()
// per second); samples are batched to every connected tab as drift-samples
// messages, which setup.ts accumulates on window.__driftSamples for the
// Playwright bench (e2e/tests/bench-ws.spec.ts).
const DRIFT_INTERVAL_MS = 1_000;
const DRIFT_BATCH_SIZE = 5;
{
  let expected = Date.now() + DRIFT_INTERVAL_MS;
  let batch: number[] = [];
  setInterval(() => {
    const now = Date.now();
    batch.push(Math.max(0, now - expected));
    expected = now + DRIFT_INTERVAL_MS;
    if (batch.length >= DRIFT_BATCH_SIZE) {
      const samples = batch;
      batch = [];
      for (const port of controlPorts) {
        try {
          port.postMessage({ type: "drift-samples", samples });
        } catch {
          // Port torn down mid-iteration — its close handler cleans up.
        }
      }
    }
  }, DRIFT_INTERVAL_MS);
}

// ── Per-tab sync-state subscriptions ────────────────────────────────────
// Each tab's control port subscribes to the documents it cares about; we push
// only those docs' heads back down that port (addressed — tab A never sees tab
// B's docs), and drop a port's whole subscription set when it closes (the tab
// went away), so there's nothing to reference-count or time out. The global
// connection/whoami signals still go over SYNCSTATE_CHANNEL.
const syncWatchers = new Map<MessagePort, Set<string>>();

// Installed by setupSyncStateBroadcast once the repo's snapshot exists, so a
// fresh `sync-sub` can be replayed the doc's current heads immediately. Null
// until then; subscriptions taken during boot are replayed when it installs.
let replaySyncForPort:
  | ((documentId: string, port: MessagePort) => void)
  | null = null;

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

// Push one document's heads to every control port currently watching it.
function pushSyncState(message: SyncStateDocMessage): void {
  for (const [port, docs] of syncWatchers) {
    if (!docs.has(message.documentId)) continue;
    try {
      port.postMessage(message);
    } catch {
      // Port already gone; its close handler will reap the entry.
    }
  }
}

// Logs emitted before any tab has connected (e.g. during wasm boot) would
// otherwise be lost — buffer a bounded number and flush on first connect.
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

function forwardToMainThread(level: string, rawArgs: any[]) {
  const args = rawArgs.map(serializeArg);
  if (!controlPorts.size) {
    if (preConnectBuffer.length < MAX_BUFFER) {
      preConnectBuffer.push({ level, args });
    }
    return;
  }
  for (const port of controlPorts) {
    try {
      port.postMessage({ type: "console", level, args });
    } catch {
      // Port may be closing — ignore.
    }
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

// Boot marker, buffered until the first tab connects. A new instance id means
// the worker restarted (fresh peerId + cold state).
console.warn(
  `[lifecycle] ${new Date(WORKER_BOOT_TIME).toISOString()} automerge ` +
    `SharedWorker started (instance ${WORKER_INSTANCE_ID})`
);

// ── Suspension watchdog ─────────────────────────────────────────────────
// A SharedWorker gets no lifecycle events, so infer freeze/suspend from timer
// drift. A large gap means keepalive pongs stalled and the server may have
// reaped us.
const WATCHDOG_TICK_MS = 5_000;
const WATCHDOG_GAP_FACTOR = 2;
let watchdogLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - watchdogLast;
  watchdogLast = now;
  if (gap > WATCHDOG_TICK_MS * WATCHDOG_GAP_FACTOR) {
    console.warn(
      `[lifecycle] worker resumed after ~${Math.round(gap / 1000)}s gap ` +
        `(timer expected every ${WATCHDOG_TICK_MS / 1000}s) — likely ` +
        `suspended/frozen/throttled; WebSocket keepalive pongs were not sent ` +
        `during this window, so the sync server may have reaped us. at ` +
        `${new Date(now).toISOString()}`
    );
  }
}, WATCHDOG_TICK_MS);

// Sync server selection. Sub is the default. Build with KEYHIVE_SYNC_SERVER=true
// to target keyhive.sync.automerge.org.
const useKeyhiveSyncServer =
  typeof __KEYHIVE_SYNC_SERVER__ !== "undefined" && __KEYHIVE_SYNC_SERVER__;

// Set the correct env var for automerge_repo_keyhive if need be.
if (useKeyhiveSyncServer) {
  (globalThis as any).process = (globalThis as any).process ?? {};
  (globalThis as any).process.env = {
    ...((globalThis as any).process.env ?? {}),
    KEYHIVE_SERVER_IDENTITY: "keyhive-sync",
  };
}

const SUBDUCTION_SYNC_URL = useKeyhiveSyncServer
  ? "wss://keyhive.sync.automerge.org"
  : "wss://subduction.sync.inkandswitch.com";

// The subduction WebSocket lives in its own worker so socket I/O (and
// keepalive pongs) keep flowing even when this SharedWorker's thread is busy
// syncing. We can't spawn that worker ourselves — Chrome doesn't expose the
// Worker constructor inside SharedWorkerGlobalScope — so tabs spawn the
// shipped SharedWorker proxy entry and donate its port to us (donatePort in
// setup.ts). The provider hands WorkerWebSocketEndpoint whichever port is
// current, healing across late arrival and proxy-worker restarts.
const subductionPortProvider = makePortProvider();

// A/B bench toggle: the tab appends ?ws-mode=inline to our URL (SharedWorker
// scope has no localStorage; see getAutomergeWorker in setup.ts). "inline"
// passes the bare URL string so the socket lives on this thread — the
// pre-worker behaviour — as the control arm for benchmarking the
// worker-based endpoint. Default: "worker".
const WS_MODE =
  new URL(self.location.href).searchParams.get("ws-mode") === "inline"
    ? "inline"
    : "worker";

// Optional windowFrames override (bench knob — max un-acked frames the io
// proxy delivers before pausing; endpoint default is 128).
const WS_WINDOW_FRAMES =
  Number(new URL(self.location.href).searchParams.get("ws-window")) ||
  undefined;

// Memoized so a repo-construction retry (getRepoHive clears its promise on
// failure) reuses the same endpoint instead of leaking one per attempt.
let subductionEndpoints: (WorkerWebSocketEndpoint | string)[] | null = null;
function getSubductionEndpoints(): (WorkerWebSocketEndpoint | string)[] {
  if (!subductionEndpoints) {
    log(`subduction websocket mode: ${WS_MODE}`);
    subductionEndpoints =
      WS_MODE === "inline"
        ? [SUBDUCTION_SYNC_URL]
        : [
            new WorkerWebSocketEndpoint(SUBDUCTION_SYNC_URL, {
              worker: subductionPortProvider.source,
              ...(WS_WINDOW_FRAMES
                ? { windowFrames: WS_WINDOW_FRAMES }
                : {}),
            }),
          ];
  }
  return subductionEndpoints;
}
const RESOLVE_TIMEOUT_MS = 30_000;

// Backoff re-sync of stuck/diverged docs. Only this worker is connected to the
// sync server, so it's the only place that can notice a doc whose heads have
// settled out of sync with the server and re-arm a sync round for it.
const RESYNC_GRACE_MS = 8_000; // must be *stably* diverged this long first
const RESYNC_INITIAL_DELAY_MS = 5_000; // first backoff cooldown after a resync
const RESYNC_MAX_DELAY_MS = 60_000; // backoff cap
const RESYNC_REVIEW_INTERVAL_MS = 5_000; // how often stuck docs are re-checked

const DEFAULT_CLASSIC_SYNC_SERVER = "wss://sync3.automerge.org";

let classicSyncServer = DEFAULT_CLASSIC_SYNC_SERVER;
let classicSyncAdapter: WebSocketWorkerClientAdapter | null = null;
let classicSyncConnectPromise: Promise<void> | null = null;

async function connectClassicSyncNetwork(server: string): Promise<void> {
  const url = server.trim() || DEFAULT_CLASSIC_SYNC_SERVER;
  if (classicSyncConnectPromise && classicSyncServer === url) {
    return classicSyncConnectPromise;
  }

  if (classicSyncAdapter && classicSyncServer !== url) {
    classicSyncAdapter.disconnect();
    classicSyncAdapter = null;
    classicSyncConnectPromise = null;
  }

  classicSyncServer = url;
  classicSyncConnectPromise = (async () => {
    const { repo } = await getRepoHive();
    if (!classicSyncAdapter) {
      classicSyncAdapter = new WebSocketWorkerClientAdapter(url);
      repo.networkSubsystem.addNetworkAdapter(classicSyncAdapter);
    }
    await classicSyncAdapter.whenReady();
    log("classic sync connected", { server: url });
  })();

  try {
    await classicSyncConnectPromise;
  } catch (err) {
    classicSyncConnectPromise = null;
    throw err;
  }
}

const siteName =
  typeof __SITE_NAME__ !== "undefined" ? __SITE_NAME__ : "tiny-patchwork";

const cacheableStatuses = [200, 203, 204];

function log(...args: any[]) {
  if (!debugging) return;
  console.log.call(
    console,
    `%cpatchwork:automergeworker%c\n`,
    `color: #ffaa00; font-weight: bold`,
    "color: inherit",
    ...args
  );
}

let repoHivePromise: Promise<{
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
}> | null = null;

const useKeyhive = typeof __KEYHIVE__ !== "undefined" && __KEYHIVE__;

function getRepoHive() {
  if (!repoHivePromise) {
    repoHivePromise = (async () => {
      log("getRepo: starting");

      log("fetching wasm modules");
      const [amWasmBuf, sdnWasmBuf] = await Promise.all([
        fetch("/automerge.wasm?worker").then((r) => r.arrayBuffer()),
        fetch("/subduction.wasm").then((r) => r.arrayBuffer()),
      ]);
      initSubductionSync(new Uint8Array(sdnWasmBuf));
      await initializeWasm(new Uint8Array(amWasmBuf));
      log("wasm initialized");

      if (!useKeyhive) {
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
          peerId: ("automerge-worker-" +
            Math.random()
              .toString(36)
              .slice(2)) as import("@automerge/automerge-repo/slim").PeerId,
          async sharePolicy(peerId) {
            return peerId.includes("storage-server");
          },
          enableRemoteHeadsGossiping: true,
          subductionWebsocketEndpoints: getSubductionEndpoints(),
        });

        console.log(
          "[patchwork] shared-worker subduction identity:",
          identity,
          "networkSubsystem.adapters:",
          repo.networkSubsystem.adapters.length
        );

        (self as any).repo = repo;
        (self as any).syncIdentity = identity;
        setupSyncStateBroadcast(repo, identity);
        log("repo constructed (no keyhive), waiting for network subsystem");

        repo.networkSubsystem.whenReady().then(() => {
          log("repo network subsystem ready");
        });

        return { repo };
      }

      // ARK variant for talking to the keyhive-enabled subduction sync server.
      const { hive, repo } = await initializeAutomergeRepoKeyhive({
        createRepo: (config) => new Repo(config),
        storage: new IndexedDBWorkerStorageAdapter(`${siteName}-keyhive`),
        peerIdSuffix: `${siteName}-worker`,
        automaticArchiveIngestion: true,
        cachingMode: "periodic",
        syncServer: useKeyhiveSyncServer ? "keyhive" : "subduction",
        repo: {
          storage: new IndexedDBWorkerStorageAdapter(),
          subductionWebsocketEndpoints: getSubductionEndpoints(),
          enableRemoteHeadsGossiping: true,
        },
      });

      (self as any).repo = repo;
      (self as any).hive = hive;
      setupSyncStateBroadcast(repo);
      log("repo constructed, waiting for network subsystem");

      // Don't block getRepoHive() on whenReady() — the network subsystem starts
      // with only the subduction adapter, and the MessageChannel adapter is
      // added later via connectPort (which awaits getRepoHive). Blocking here
      // would deadlock that path and starve the handoff handler.
      repo.networkSubsystem.whenReady().then(() => {
        log("repo network subsystem ready");
      });

      hive.networkAdapter.whenReady().then(() => {
        hive.networkAdapter.syncKeyhive();
      });

      return { hive, repo };
    })();
    // If construction fails (e.g. wasm fetch errors out), don't permanently
    // cache the rejection — clear the slot so the next caller can retry from
    // scratch.
    repoHivePromise.catch(() => {
      repoHivePromise = null;
    });
  }
  return repoHivePromise;
}

// ── Sync-state broadcast ───────────────────────────────────────────────
//
// Only this worker is directly connected to the sync server, so it's the only
// place that learns the server's heads (the repo's "subduction-remote-heads"
// event, keyed by each Subduction peer's verifying-key storageId) and whether
// the server link is up ("subduction-connection"). We rebroadcast both on
// SYNCSTATE_CHANNEL so every tab can render a sync indicator without holding
// its own server connection. A tab that opens mid-stream posts {type:"request"}
// to get the current snapshot replayed.

let syncStateWired = false;

function setupSyncStateBroadcast(
  repo: Repo,
  identity?: { peerId: string; verifyingKey: string }
): void {
  if (syncStateWired) return;
  syncStateWired = true;

  const channel = new BroadcastChannel(SYNCSTATE_CHANNEL);
  // documentId -> storageId (verifying key) -> last-known heads
  const snapshot = new Map<
    string,
    Map<string, { heads: string[]; timestamp: number }>
  >();
  let connected = repo.isSubductionConnected();
  // Directly-connected sync-server peer ids (verifying keys). Stable once
  // known; tabs use this to judge "synced" against the server specifically.
  let serverPeerIds: string[] = [];

  const postWhoAmI = () => {
    if (!identity) return;
    channel.postMessage({
      type: "whoami",
      peerId: identity.peerId,
      verifyingKey: identity.verifyingKey,
    } satisfies SyncStateBroadcast);
  };
  // Announce our identity so tabs can label which peer rows are this worker.
  postWhoAmI();

  // Heads are addressed, not broadcast: push a doc's heads only to the control
  // ports that subscribed to it (see syncWatchers / pushSyncState).
  const postHeads = (
    documentId: string,
    storageId: string,
    heads: string[],
    timestamp: number
  ) =>
    pushSyncState({
      type: "sync-state",
      documentId,
      storageId,
      heads,
      timestamp,
    });

  // Let a `sync-sub` (which may have arrived while the repo was still booting)
  // replay this doc's current snapshot to the subscribing port immediately.
  const replayDoc = (documentId: string, port: MessagePort) => {
    const byStorage = snapshot.get(documentId);
    if (!byStorage) return;
    for (const [storageId, { heads, timestamp }] of byStorage) {
      try {
        port.postMessage({
          type: "sync-state",
          documentId,
          storageId,
          heads,
          timestamp,
        } satisfies SyncStateDocMessage);
      } catch {
        // Port gone; its close handler reaps it.
      }
    }
  };
  replaySyncForPort = replayDoc;
  // Catch up any ports that subscribed before this wiring existed.
  for (const [port, docs] of syncWatchers) {
    for (const documentId of docs) replayDoc(documentId, port);
  }

  const postConnection = () =>
    channel.postMessage({
      type: "connection",
      connected,
      serverPeerIds,
    } satisfies SyncStateBroadcast);

  // Learn (and re-announce) which connected Subduction peer is the sync server.
  // The peer list is empty until the handshake finishes, so retry briefly.
  const refreshServerPeers = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const ids = await repo.connectedSubductionPeerIds();
        if (ids.length > 0) {
          serverPeerIds = ids;
          postConnection();
          return;
        }
      } catch {
        // repo has no subduction source / not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  // Advertise the worker's OWN heads for every doc it holds (keyed by our
  // verifying key), so the worker hop is visible on every document.
  //
  // Docs pushed in by Subduction that this worker never explicitly opened don't
  // surface via the repo's "document" event, so we discover them by re-scanning
  // repo.handles (on a tick, and whenever the server reports a doc) and attach a
  // heads-changed listener once per doc. No-op when there's no identity (keyhive
  // path).
  const ownTracked = new Set<string>();
  const broadcastOwnHeads = (handle: {
    documentId: string;
    heads: () => string[];
  }) => {
    if (!identity) return;
    const documentId = handle.documentId;
    let heads: string[];
    try {
      heads = [...handle.heads()];
    } catch {
      return; // handle not ready yet
    }
    const timestamp = Date.now();
    let byStorage = snapshot.get(documentId);
    if (!byStorage) {
      byStorage = new Map();
      snapshot.set(documentId, byStorage);
    }
    byStorage.set(identity.peerId, { heads, timestamp });
    postHeads(documentId, identity.peerId, heads, timestamp);
    reviewResync(documentId);
  };
  const trackOwnHandle = (handle: {
    documentId: string;
    heads: () => string[];
    on: (ev: "heads-changed", cb: () => void) => void;
  }) => {
    if (!identity || ownTracked.has(handle.documentId)) return;
    ownTracked.add(handle.documentId);
    handle.on("heads-changed", () => broadcastOwnHeads(handle));
    broadcastOwnHeads(handle);
  };
  const scanOwnHandles = () => {
    if (!identity) return;
    for (const handle of Object.values(repo.handles)) {
      trackOwnHandle(handle as never);
    }
  };

  // ── Backoff re-sync of stuck/diverged docs ──────────────────────────
  //
  // Subduction sync is event-driven and only retries syncs it observed *fail*;
  // a doc that settles missing commits the server holds — or whose heal retries
  // were exhausted — is otherwise never retried. When we're behind and the
  // server's advertised heads haven't advanced for a grace window (so it's
  // genuinely stuck, not just lagging a live edit), we re-arm its sync round
  // with per-doc exponential backoff. Convergence clears the state.
  const serverHeadSetsFor = (documentId: string): string[][] => {
    const byStorage = snapshot.get(documentId);
    if (!byStorage) return [];
    const sets: string[][] = [];
    for (const [storageId, { heads }] of byStorage) {
      if (serverPeerIds.includes(storageId)) sets.push(heads);
    }
    return sets;
  };
  const resyncState = new Map<
    string,
    { serverSig: string; since: number; delay: number; lastResyncAt: number }
  >();
  // Inspectable from the SharedWorker console as `self.patchworkResync` to see
  // whether/how often a doc is being re-synced and against which server heads.
  const resyncDiag: { fires: number; byDoc: Record<string, unknown> } =
    ((self as any).patchworkResync ??= { fires: 0, byDoc: {} });
  const reviewResync = (documentId: string) => {
    if (!identity || !connected) {
      resyncState.delete(documentId);
      return;
    }
    const handle = repo.handles[documentId as DocumentId];
    if (!handle) return;
    const serverSets = serverHeadSetsFor(documentId);
    if (serverSets.length === 0) {
      resyncState.delete(documentId); // no server signal to compare against
      return;
    }
    // The server advertises subduction *sedimentree* heads (loose-commit +
    // fragment-boundary commit ids), which are NOT the Automerge frontier — so
    // never compare them to handle.heads() for equality. Instead ask whether we
    // already hold every commit the server advertises (`DocHandle.containsHeads`).
    // If we do, the server has nothing we're missing → caught up. If not, we're
    // genuinely behind and a re-sync can pull the rest.
    const serverHeadsUrl = [...new Set(serverSets.flat())] as UrlHeads;
    let haveAll: boolean;
    try {
      haveAll = handle.containsHeads(serverHeadsUrl);
    } catch {
      return; // doc not ready, or an undecodable head
    }
    if (haveAll) {
      resyncState.delete(documentId); // we hold everything the server has
      return;
    }
    // Behind. "Stuck" = the server's advertised set hasn't advanced (no
    // progress) for a while. Key the grace timer on the server heads only, so
    // your own edits churning don't keep resetting it.
    const serverSig = [...serverHeadsUrl].sort().join(",");
    const now = Date.now();
    const prev = resyncState.get(documentId);
    if (!prev || prev.serverSig !== serverSig) {
      // First sighting, or the server advanced its view (progress): restart.
      resyncState.set(documentId, {
        serverSig,
        since: now,
        delay: RESYNC_INITIAL_DELAY_MS,
        lastResyncAt: 0,
      });
      return;
    }
    if (now - prev.since < RESYNC_GRACE_MS) return; // not stuck long enough yet
    if (now - prev.lastResyncAt < prev.delay) return; // within backoff cooldown
    log("re-syncing behind doc", documentId, { serverSets });
    resyncDiag.fires++;
    resyncDiag.byDoc[documentId] = {
      at: now,
      count:
        ((resyncDiag.byDoc[documentId] as { count?: number } | undefined)
          ?.count ?? 0) + 1,
      serverSets,
    };
    try {
      repo.resyncSubduction(documentId as DocumentId);
    } catch (e) {
      log("resyncSubduction failed", e);
    }
    prev.lastResyncAt = now;
    prev.delay = Math.min(prev.delay * 2, RESYNC_MAX_DELAY_MS);
  };
  const reviewAllResync = () => {
    if (!identity) return;
    for (const documentId of snapshot.keys()) reviewResync(documentId);
    for (const id of [...resyncState.keys()]) {
      if (!snapshot.has(id)) resyncState.delete(id);
    }
  };

  repo.on(
    "subduction-remote-heads",
    ({ documentId, storageId, heads, timestamp }) => {
      const headsCopy = [...heads];
      let byStorage = snapshot.get(documentId);
      if (!byStorage) {
        byStorage = new Map();
        snapshot.set(documentId, byStorage);
      }
      byStorage.set(storageId, { heads: headsCopy, timestamp });
      postHeads(documentId, storageId, headsCopy, timestamp);
      // A doc the server reported is one we hold — make sure we're advertising
      // our own heads for it too.
      scanOwnHandles();
      reviewResync(documentId);
    }
  );

  repo.on("subduction-connection", ({ connected: isConnected }) => {
    connected = isConnected;
    postConnection();
    if (isConnected) void refreshServerPeers();
  });

  // A BroadcastChannel never receives its own posts, so this only sees tabs'
  // requests, never our own broadcasts. We replay just the global signals here;
  // a late tab gets per-doc heads by subscribing (sync-sub), not from this.
  channel.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SyncStateRequestMessage;
    if (data?.type !== "request") return;
    postWhoAmI();
    postConnection();
  });

  // In case we're already connected by the time this wires up.
  void refreshServerPeers();

  // Discover the worker's docs by re-scanning repo.handles initially and on a
  // tick (Subduction-pushed docs don't surface via the "document" event).
  scanOwnHandles();
  if (identity) setInterval(scanOwnHandles, 3000);

  // Drive the backoff re-sync of stuck/diverged docs. A tick is essential here:
  // the "stuck" case is precisely when no head events are firing, so the
  // grace/backoff timers can only advance on a timer.
  if (identity) setInterval(reviewAllResync, RESYNC_REVIEW_INTERVAL_MS);
}

// ── Tab connections ────────────────────────────────────────────────────

// Each tab connects with a control port (the SharedWorker connect port) and
// opens repo MessageChannel ports through it. `adapter` is what was
// registered with the network subsystem (the MessageChannelNetworkAdapter,
// or the keyhive wrapper around it); `mcAdapter` is always the underlying
// MessageChannel adapter so we can disconnect the port itself.
type RepoChannel = {
  adapter: { disconnect(): void };
  mcAdapter: MessageChannelNetworkAdapter;
  port: MessagePort;
};
type Connection = {
  channels: Set<RepoChannel>;
};

function dropRepoChannel(repo: Repo, channel: RepoChannel) {
  // removeNetworkAdapter pulls the adapter out of networkSubsystem.adapters and
  // calls adapter.disconnect(), which (for the MessageChannel adapter) emits the
  // "close"/"peer-disconnected" events that also clear #adaptersByPeer.
  try {
    repo.networkSubsystem.removeNetworkAdapter(channel.adapter as any);
  } catch (err) {
    console.error("removeNetworkAdapter failed", err);
  }
  // Belt and braces for the keyhive path, where the registered adapter is a
  // wrapper: make sure the underlying port is disconnected and closed too.
  try {
    channel.mcAdapter.disconnect();
  } catch {
    // Already disconnected by removeNetworkAdapter above.
  }
  try {
    channel.port.close();
  } catch {
    // Port already closed by the departing tab.
  }
}

async function dropConnection(connection: Connection) {
  if (!connection.channels.size || !repoHivePromise) return;
  const { repo } = await getRepoHive();
  log(`tab gone — removing ${connection.channels.size} network adapter(s)`);
  for (const channel of connection.channels) {
    dropRepoChannel(repo, channel);
  }
  connection.channels.clear();
}

// Connect client MessagePorts to the repo for sync
async function connectPort(port: MessagePort, connection: Connection) {
  const { hive, repo } = await getRepoHive();
  const networkAdapter = new MessageChannelNetworkAdapter(port, {
    useWeakRef: true,
  });

  const track = (adapter: { disconnect(): void }) => {
    connection.channels.add({ adapter, mcAdapter: networkAdapter, port });
  };

  if (!hive) {
    repo.networkSubsystem.addNetworkAdapter(networkAdapter);
    track(networkAdapter);
    return;
  }

  const keyhiveNetworkAdapter = hive.createKeyhiveNetworkAdapter(networkAdapter);

  keyhiveNetworkAdapter.on("message", async (msg: any) => {
    if ((msg.type === "sync" || msg.type === "request") && msg.documentId) {
      const handle = repo.handles[msg.documentId];
      if (!handle || handle.state === "unavailable") {
        const url = `automerge:${msg.documentId}` as AutomergeUrl;
        repo.findWithProgress(url);
        repo.shareConfigChanged();
      }
    }
  });

  keyhiveNetworkAdapter.on("ingest-remote", () => {
    hive.notifySameAgentKeyhiveChange();
    hive.networkAdapter.syncKeyhive();
    repo.shareConfigChanged();
  });

  repo.networkSubsystem.addNetworkAdapter(keyhiveNetworkAdapter);
  track(keyhiveNetworkAdapter);
}

function handleControlMessage(
  event: MessageEvent,
  controlPort: MessagePort,
  connection: Connection
) {
  const data = event.data;
  if (data?.type === "port") {
    log("received repo channel");
    const [repoPort] = event.ports;
    const id = data.id;
    connectPort(repoPort, connection).then(
      () => controlPort.postMessage({ type: "port-ready", id }),
      (err) => {
        console.error("connectPort failed", err);
        // Tell the client we failed so it doesn't hang forever.
        controlPort.postMessage({
          type: "port-failed",
          id,
          error: String(err),
        });
      }
    );
  } else if (data?.type === "sync-sub") {
    if (typeof data.documentId === "string") {
      syncSubscribe(controlPort, data.documentId);
    }
  } else if (data?.type === "sync-unsub") {
    if (typeof data.documentId === "string") {
      syncUnsubscribe(controlPort, data.documentId);
    }
  } else if (data?.type === "debug") {
    debugging = data.debug;
    log("automerge worker debugging enabled");
  } else if (data?.type === "connect-classic-sync") {
    const [replyPort] = event.ports;
    const server =
      typeof data.server === "string"
        ? data.server
        : DEFAULT_CLASSIC_SYNC_SERVER;
    connectClassicSyncNetwork(server)
      .then(() => {
        replyPort?.postMessage({ type: "connect-classic-sync-ready" });
        replyPort?.close();
        log("classic sync connected on demand", { server });
      })
      .catch((err) => {
        console.error("connectClassicSyncNetwork failed", err);
        replyPort?.postMessage({
          type: "connect-classic-sync-failed",
          error: String(err),
        });
        replyPort?.close();
      });
  } else if (data?.type === "ping") {
    // Heartbeat: reply so the tab can detect our death or restart.
    controlPort.postMessage({
      type: "pong",
      id: data.id,
      instanceId: WORKER_INSTANCE_ID,
    });
  }
}

self.addEventListener("connect", (event) => {
  const controlPort = (event as MessageEvent).ports[0];
  const connection: Connection = { channels: new Set() };

  controlPort.addEventListener("message", (messageEvent) => {
    handleControlMessage(messageEvent as MessageEvent, controlPort, connection);
  });

  // Let the subduction port provider negotiate over this tab's control port
  // (the tab side runs donatePort; the messages are channel-tagged so they
  // coexist with our control protocol above).
  subductionPortProvider.attachClient(controlPort);

  // Fires when the owning page is destroyed. Browsers without the close
  // event fall back to the adapters' lazy useWeakRef cleanup.
  controlPort.addEventListener("close", () => {
    controlPorts.delete(controlPort);
    // The tab is gone — drop its sync subscriptions wholesale so we stop
    // pushing it heads (no per-doc unsub needed, no leak).
    syncWatchers.delete(controlPort);
    void dropConnection(connection);
  });

  controlPort.start();

  // Greet the tab with our per-boot instance id so it can detect a restart
  // (a different id than last seen) even if no port "close" fired.
  controlPort.postMessage({
    type: "hello",
    instanceId: WORKER_INSTANCE_ID,
    bootTime: WORKER_BOOT_TIME,
  });

  // Start forwarding console output to this tab, and flush anything buffered
  // while no tab was connected (e.g. boot-time logs) to the first arrival.
  controlPorts.add(controlPort);
  if (preConnectBuffer.length) {
    for (const { level, args } of preConnectBuffer.splice(0)) {
      try {
        controlPort.postMessage({ type: "console", level, args });
      } catch {
        // Port may already be gone — ignore.
      }
    }
  }
});

// ── Automerge URL resolution ───────────────────────────────────────────

/**
 * Wait for the requested heads to appear in the handle's local history —
 * they may still be syncing toward us when the request lands. Resolves
 * false if the signal aborts before they arrive.
 */
function waitForHeads(
  handle: DocHandle<unknown>,
  hexHeads: string[],
  signal: AbortSignal
): Promise<boolean> {
  if (hasHeads(handle.doc(), hexHeads)) return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const check = () => {
      if (!hasHeads(handle.doc(), hexHeads)) return;
      cleanup();
      resolve(true);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      handle.off("heads-changed", check);
      signal.removeEventListener("abort", onAbort);
    };
    handle.on("heads-changed", check);
    signal.addEventListener("abort", onAbort);
    // The heads may have landed between the synchronous check above and
    // subscribing.
    check();
  });
}

async function resolveAutomergeUrl(automergeURL: URL): Promise<Response> {
  const { repo } = await getRepoHive();
  const href = automergeURL.href;
  const [maybeAutomergeUrl, ...path] = href.split("/");

  if (!isValidAutomergeUrl(maybeAutomergeUrl)) {
    return new Response("invalid automerge url", { status: 400 });
  }

  // Trim trailing empty path segment
  if (path.length && !path[path.length - 1]) path.pop();

  const { heads, hexHeads, documentId } = parseAutomergeUrl(maybeAutomergeUrl);
  const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);

  if (!heads) {
    const folder = await repo.find(maybeAutomergeUrl, { signal });
    const latestHeads = folder.heads();
    const url = stringifyAutomergeUrl({ documentId, heads: latestHeads });
    let location = `/${encodeURIComponent(url)}`;
    if (path.length) location += `/${path.join("/")}`;
    return Response.redirect(location, 307);
  }

  // Load by documentId only so we can verify the requested heads are actually
  // in our local history. repo.find with a heads-bearing URL returns a view
  // at those heads, which silently materializes garbage if we never synced them.
  const baseHandle = await repo.find(stringifyAutomergeUrl({ documentId }), {
    signal,
  });
  // The heads may not have synced to us yet — give them the rest of the
  // resolve window to arrive before giving up.
  if (!(await waitForHeads(baseHandle, hexHeads ?? [], signal))) {
    return new Response("heads not found", { status: 404 });
  }
  const rootHandle = baseHandle.view(heads);

  const resolved = await resolvePath(
    repo,
    rootHandle,
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

// ── Handoff: resolve special URLs for the service worker ──────────────

const handoffChannel = new BroadcastChannel(HANDOFF_CHANNEL);

/**
 * Pull the special URL out of a handoff request, whichever generation of
 * service worker sent it. Returns null rather than throwing — a stale
 * worker on the other end of the channel can send us anything.
 */
function parseHandoffhandoffURL(request: HandoffRequest): URL | null {
  try {
    // The service worker already decoded the special URL out of the
    // request it's holding and sends it alongside.
    if (request.handoffURL) return new URL(request.handoffURL);
    // TODO(backcompat): a briefly-deployed shape sent the special URL in
    // request.url and the http URL in cacheKey.
    if (request.cacheKey) return new URL(request.url);
    // TODO(backcompat): older service workers send only the http URL,
    // special URL still URI-encoded in its pathname.
    return new URL(decodeURIComponent(new URL(request.url).pathname.slice(1)));
  } catch {
    return null;
  }
}

async function handleHandoffRequest(message: HandoffRequestMessage) {
  const { id, cachename, request } = message;

  const handoffURL = parseHandoffhandoffURL(request);
  if (!handoffURL) {
    console.error(
      `automerge worker couldn't parse a special url out of handoff request`,
      request
    );
    handoffChannel.postMessage({
      id,
      type: "response",
      response: {
        status: 400,
        body: `couldn't parse a special url out of ${request.url}`,
        headers: { "content-type": "text/plain" },
      },
    } satisfies HandoffResponseMessage);
    return;
  }

  if (handoffURL.protocol != "automerge:") {
    // This worker only resolves automerge: URLs. Other handlers may be
    // listening on the channel for other schemes — stay quiet rather than
    // clobbering their reply with an error.
    return log(`ignoring handoff ${id} for non-automerge url ${handoffURL}`);
  }

  let response: Response;
  try {
    log(`resolving handoff ${id} for ${handoffURL}`);
    response = await Promise.race([
      resolveAutomergeUrl(handoffURL),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`resolve timeout after ${RESOLVE_TIMEOUT_MS}ms`)),
          RESOLVE_TIMEOUT_MS
        )
      ),
    ]);
  } catch (error) {
    const body =
      error instanceof Error
        ? `${error.message}\n\n${error.stack}`
        : String(error);
    console.error(`automerge worker error resolving ${request.url}`, error);
    handoffChannel.postMessage({
      id,
      type: "response",
      response: {
        status: 557,
        body,
        headers: { "content-type": "text/plain" },
      },
    } satisfies HandoffResponseMessage);
    return;
  }

  try {
    if (cacheableStatuses.includes(response.status)) {
      // Reconstruct the request the service worker is holding so the entry
      // matches on its cache.match. (destination isn't constructible, but it
      // doesn't participate in cache matching.) request.url is the http URL
      // the SW is holding except in the briefly-deployed cacheKey shape.
      const cacheKey = new Request(request.cacheKey ?? request.url, {
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
    } else {
      // Errors, redirects &c — things that shouldn't be cached — go back
      // inline for the service worker to serve directly.
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
    }
  } catch (error) {
    console.error(`automerge worker failed to reply for ${request.url}`, error);
    handoffChannel.postMessage({
      id,
      type: "response",
      response: {
        status: 558,
        body: String(error),
        headers: { "content-type": "text/plain" },
      },
    } satisfies HandoffResponseMessage);
  }
}

handoffChannel.addEventListener("message", (event) => {
  if (event.data?.type === "request") {
    void handleHandoffRequest(event.data as HandoffRequestMessage);
  }
});

// Announce ourselves so the service worker can re-broadcast any handoff
// requests that were sent while we were still booting.
handoffChannel.postMessage({ type: "online" } satisfies HandoffOnlineMessage);
