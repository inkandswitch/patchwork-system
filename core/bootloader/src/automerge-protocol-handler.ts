// The Repo that resolves `automerge:` URLs for the service worker, in a
// SharedWorker: one instance serves every tab and lives as long as any tab
// does. The worker's script is automerge-protocol-handler-worker.ts, which
// takes the lock and then imports this.
//
// It also hosts the origin's sync node (sync-node.ts), the one Subduction node
// with a connection to the sync server. Every tab's Repo syncs through it, and
// so does the resolver Repo here, which is otherwise a Repo like any tab's: the
// same IndexedDB and the storage channel to the tabs.
// When the service worker misses the cache for a request that looks like a URL
// encoded URL, it broadcasts a HandoffRequestMessage on HANDOFF_CHANNEL; we
// resolve the automerge URL, write the response into the service worker's
// cache (keyed by a Request reconstructed to match the one it's holding), and
// reply on the same channel.
import {
  initializeWasm,
  getChangesMetaSince,
  hasHeads,
  stats,
} from "@automerge/automerge/slim";
// eslint-disable-next-line
// @ts-ignore — the default init is a wasm-bindgen runtime helper not in the .d.ts
import initSubduction from "@automerge/automerge-subduction/slim";

import {
  INTERCEPTOR_PREFIX,
  Repo,
  isImmutableString,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type PeerId,
  type StorageId,
} from "@automerge/automerge-repo/slim";
import {
  getDefaultBranch,
  packageDocuments,
  resolvePath,
} from "@inkandswitch/patchwork-filesystem";

import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket";
import type {
  AutomergeRepoKeyhive,
  SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";

import { DEFAULT_CLASSIC_SYNC_SERVER } from "./sync-config.js";
import { loadKeyhiveSigner, loadOrCreateSigner } from "./signer.js";
import { keyhiveStorageName, storagePrefix } from "./storage.js";
import { startWorkerControl } from "./worker-control.js";
import { SyncNode } from "./sync-node.js";
import { AUTOMERGE_WASM, SUBDUCTION_WASM } from "./emitted.js";
import { PortSyncRemote, relayKeyhive } from "./sync-remote.js";
import {
  AUTOMERGE_WORKER_LOCK,
  HANDOFF_CHANNEL,
  LOADED_CACHE,
  PACKAGE_MEMORY_CHANNEL,
  type HandoffCachedMessage,
  type HandoffOnlineMessage,
  type HandoffAbortMessage,
  type HandoffRequestMessage,
  type HandoffResponseMessage,
  type PackageMemoryAcceptedMessage,
  type PackageMemoryDocument,
  type PackageMemoryReplyMessage,
  type PackageMemoryRequestMessage,
} from "./types.js";

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: SyncServerSelection;
  useIdFactory?: boolean;
};

const syncServer =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };

const RESOLVE_TIMEOUT_MS = 30_000;

const CACHEABLE_STATUSES = [200, 203, 204];

const control = startWorkerControl("automerge-protocol-handler-worker", {
  onMessage: handleControlMessage,
  onRestart: drainForRestart,
  lock: AUTOMERGE_WORKER_LOCK,
});
// The sync node and the Repo wait for the lock: until the previous instance
// is gone, it's still syncing and resolving, against the same IndexedDB.
let holdingLock = false;
void control.holding.then(() => (holdingLock = true));
const log = control.log;

// ── The sync node ──────────────────────────────────────────────────────

let wasmPromise: Promise<void> | null = null;

function initWasm(): Promise<void> {
  if (!wasmPromise) {
    log("fetching wasm");
    watchWasmMemories();
    wasmPromise = Promise.all([
      initializeWasm(new Request(AUTOMERGE_WASM)),
      initSubduction(new Request(SUBDUCTION_WASM)),
    ]).then(() => log("wasm initialized"));
    wasmPromise.catch(() => {
      wasmPromise = null;
    });
  }
  return wasmPromise;
}

let syncNodePromise: Promise<SyncNode> | null = null;

function getSyncNode(): Promise<SyncNode> {
  if (!syncNodePromise) {
    syncNodePromise = (async () => {
      await control.holding;
      await initWasm();
      const storage = new IndexedDBStorageAdapter();
      // On keyhive sites the Repos store encrypted documents under the
      // interceptor's prefix and sign as the keyhive identity.
      const node = new SyncNode({
        signer: syncServer.keyhive
          ? await loadKeyhiveSigner(
              new IndexedDBStorageAdapter(keyhiveStorageName)
            )
          : await loadOrCreateSigner(storage),
        storage,
        storagePrefix: syncServer.keyhive ? INTERCEPTOR_PREFIX : undefined,
        endpoints: [syncServer.url],
        log,
      });
      (self as any).syncNode = node;
      return node;
    })();
    // Nothing syncs without it: start again from scratch, as a new instance.
    syncNodePromise.catch((error) => {
      syncNodePromise = null;
      control.fail("the sync node failed to start", error);
    });
  }
  return syncNodePromise;
}

/** Serve a Repo on `port` once the node is up; messages queue until then. */
function connectToSyncNode(port: MessagePort): void {
  getSyncNode().then(
    (node) => node.connect(port),
    (error) => {
      console.error("sync node failed to start", error);
      port.close();
    }
  );
}

/** The resolver Repo's connection to the node, which lives right here. */
function resolverRemote(): PortSyncRemote {
  return new PortSyncRemote(() => {
    const { port1, port2 } = new MessageChannel();
    connectToSyncNode(port2);
    return port1;
  });
}

// ── The repo ───────────────────────────────────────────────────────────

let repoPromise: Promise<Repo> | null = null;

function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = buildRepo();
    // Nothing resolves without it (the wasm fetch failed, say): start again
    // from scratch, as a new instance.
    repoPromise.catch((error) => {
      repoPromise = null;
      control.fail("the resolver's Repo failed to start", error);
    });
  }
  return repoPromise;
}

let builtRepo: Repo | undefined;

// For the console. The Repo is only built once something has to be resolved,
// so before then reading `repo` starts building it and gives its promise:
// `await repo` works either way.
Object.defineProperty(self, "repo", {
  configurable: true,
  get: () => builtRepo ?? getRepo(),
});

async function buildRepo(): Promise<Repo> {
  await control.holding;
  await initWasm();

  const { repo, hive } = syncServer.keyhive
    ? await buildKeyhiveRepo(syncServer.keyhive)
    : { repo: await buildPlainRepo() };

  builtRepo = repo;
  if (hive) (self as any).hive = hive;
  return repo;
}

async function buildPlainRepo(): Promise<Repo> {
  const storage = new IndexedDBStorageAdapter();
  return new Repo({
    signer: await loadOrCreateSigner(storage),
    storage,
    peerId:
      `${storagePrefix}-resolver-${Math.random().toString(36).slice(2)}` as PeerId,
    subductionRemote: resolverRemote(),
    headsChannel: `${storagePrefix}-heads`,
    enableRemoteHeadsGossiping: true,
  });
}

async function buildKeyhiveRepo(
  keyhiveSyncServer: SyncServerSelection
): Promise<{ repo: Repo; hive: AutomergeRepoKeyhive }> {
  const { initKeyhiveWasm, initializeAutomergeRepoKeyhive } =
    await import("@automerge/automerge-repo-keyhive");
  initKeyhiveWasm();
  const remote = resolverRemote();
  const { hive, repo } = await initializeAutomergeRepoKeyhive({
    // ARK injects an `idFactory` deriving document ids from keyhive. A site
    // can opt out of it with `keyhive: { useIdFactory: false }`.
    createRepo: ({ idFactory, ...config }) =>
      relayKeyhive(
        new Repo(
          syncServer.useIdFactory === false ? config : { ...config, idFactory }
        ),
        remote
      ),
    storage: new IndexedDBStorageAdapter(keyhiveStorageName),
    peerIdSuffix:
      `${storagePrefix}-resolver` + Math.random().toString(36).slice(2),
    automaticArchiveIngestion: true,
    cachingMode: "periodic",
    // ARK selects the relay via `syncServer`, which pairs the contact card with
    // the matching peer id. Omitting it defaults to "subduction".
    syncServer: keyhiveSyncServer,
    repo: {
      storage: new IndexedDBStorageAdapter(),
      subductionRemote: remote,
      headsChannel: `${storagePrefix}-heads`,
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
    const repo = await getRepo();
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

// ── Control protocol ───────────────────────────────────────────────────

function handleControlMessage(
  data: any,
  controlPort: MessagePort,
  event: MessageEvent
): void {
  if (data?.type === "sync-connect") {
    const [port] = event.ports;
    if (port) connectToSyncNode(port);
    return;
  }
  if (data?.type !== "connect-classic-sync") return;
  const [replyPort] = event.ports;
  const server =
    typeof data.server === "string" ? data.server : DEFAULT_CLASSIC_SYNC_SERVER;
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
}

// ── Resolving ──────────────────────────────────────────────────────────

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

const CATCH_UP_MS = 3_000;

async function caughtUpWithPeers(
  repo: Repo,
  handle: DocHandle<unknown>,
  signal: AbortSignal
): Promise<void> {
  if (!repo.isSubductionConnected()) return;
  const peers = (await repo.connectedSubductionPeerIds()) as StorageId[];
  const caughtUp = () => {
    const states = peers.map((peer) => handle.isCaughtUpWith(peer));
    return (
      states.some((state) => state !== undefined) && !states.includes(false)
    );
  };
  if (caughtUp() || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      handle.off("remote-heads", check);
      handle.off("heads-changed", check);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (caughtUp()) done();
    };
    const timer = setTimeout(done, CATCH_UP_MS);
    handle.on("remote-heads", check);
    handle.on("heads-changed", check);
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
    else check();
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
  const repo = await getRepo();
  // What it finds, to record against the package.
  const found: DocHandle<unknown>[] = [];
  const find = async <T>(id: AnyDocumentId) => {
    const handle = await repo.find<T>(id, { signal });
    found.push(handle as DocHandle<unknown>);
    return handle;
  };
  // `resolvePath` only finds documents.
  const tracked: Repo = Object.create(repo, { find: { value: find } });
  const [maybeAutomergeUrl, ...path] = automergeURL.href.split("/");

  if (!isValidAutomergeUrl(maybeAutomergeUrl)) {
    return new Response("invalid automerge url", { status: 400 });
  }

  if (path.length && !path[path.length - 1]) path.pop();

  const { heads, hexHeads, documentId } = parseAutomergeUrl(maybeAutomergeUrl);

  // todo, maybe a bad idea? maybe we should throw instead of es-module-caching
  // the headless req
  if (!heads) {
    let folder = await find(maybeAutomergeUrl);
    await caughtUpWithPeers(repo, folder, signal);
    // Packages used to be published as a branches doc, which stands for its
    // default branch. The tab's ModuleWatcher looks packages up through here,
    // so this is where that's followed.
    const branch = getDefaultBranch(folder.doc());
    if (branch) {
      folder = await find(branch);
      await caughtUpWithPeers(repo, folder, signal);
      branchOf.set(documentId, folder.documentId);
    }
    const url = stringifyAutomergeUrl({
      documentId: folder.documentId,
      heads: folder.heads(),
    });
    const location = `/${encodeURIComponent(url)}${path.length ? `/${path.join("/")}` : ""}`;
    return Response.redirect(location, 307);
  }

  const baseHandle = await find(stringifyAutomergeUrl({ documentId }));
  if (!(await waitForHeads(baseHandle, hexHeads ?? [], signal))) {
    throw new AbortHandoff(
      `heads not found for ${maybeAutomergeUrl} within ${RESOLVE_TIMEOUT_MS}ms`
    );
  }

  const resolved = await resolvePath(
    tracked,
    baseHandle.view(heads),
    path.map(decodeURIComponent)
  );
  if (!resolved) {
    throw new Error(
      `couldn't resolve ${path.join("/")} in folder at ${maybeAutomergeUrl}`
    );
  }
  recordLoaded(documentId, found, path.map(decodeURIComponent).join("/"));

  const body: BodyInit =
    resolved.content instanceof Uint8Array
      ? (new Uint8Array(resolved.content) as BlobPart)
      : resolved.content;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": resolved.type,
      "cache-control": resolved.pinned
        ? "public, max-age=31536000, immutable"
        : "no-store",
    },
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

const EVICT_IDLE_MS = 5_000;
let handoffsInFlight = 0;
let evictTimer: ReturnType<typeof setTimeout> | undefined;

function handoffStarted() {
  handoffsInFlight++;
  clearTimeout(evictTimer);
  clearTimeout(recycleTimer);
}

function handoffFinished() {
  if (--handoffsInFlight > 0) return;
  clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    evictLoaded().catch((error) => console.error("eviction failed", error));
  }, EVICT_IDLE_MS);
  clearTimeout(recycleTimer);
  recycleTimer = setTimeout(recycleIfHolding, RECYCLE_IDLE_MS);
}

// ── Recycling ──────────────────────────────────────────────────────────
// A wasm memory grows and never shrinks: a module holds the most it ever
// needed at once until its global goes. Resolving packages at boot takes the
// resolver Repo's automerge to 90–130MB, and letting the documents go gives
// none of it back. So once handoffs stop for RECYCLE_IDLE_MS, an instance whose
// wasm has grown by more than RECYCLE_AT_MB restarts itself, as it does for a
// new build: tabs spawn the replacement and reconnect their sync (classic sync
// too), the service worker re-sends any handoff still unanswered, and what was
// resolved is in its cache, so the replacement doesn't load it all again.

const RECYCLE_AT_MB = 64;
const RECYCLE_IDLE_MS = 15_000;
let recycleTimer: ReturnType<typeof setTimeout> | undefined;

/** Every wasm memory instantiated here, with the file it was compiled from. */
const wasmMemories: Array<{ url: string; memory: WebAssembly.Memory }> = [];
let watchingWasm = false;

/**
 * Note the memory of every wasm instance instantiated from a response from
 * here on: automerge and subduction instantiate from their `Request`s that
 * way, and don't hand back the instance.
 */
function watchWasmMemories() {
  if (watchingWasm) return;
  watchingWasm = true;
  const wasm = WebAssembly as {
    instantiateStreaming: typeof WebAssembly.instantiateStreaming;
  };
  const instantiateStreaming = wasm.instantiateStreaming;
  wasm.instantiateStreaming = async (source, imports) => {
    const response = await source;
    const result = await instantiateStreaming(response, imports);
    for (const value of Object.values(result.instance.exports)) {
      if (value instanceof WebAssembly.Memory) {
        wasmMemories.push({ url: response.url, memory: value });
      }
    }
    return result;
  };
}

const wasmBytes = (file: string) =>
  wasmMemories
    .filter(
      ({ url }) =>
        new URL(url, self.location.href).pathname ===
        new URL(file, self.location.href).pathname
    )
    .reduce((bytes, { memory }) => bytes + memory.buffer.byteLength, 0);

// Subduction holds the sync node's trees, which a replacement holds again as
// soon as it starts, so only what it grew past that counts. It's taken the
// first time this instance looks, by when the node has loaded them.
let subductionBaseline: number | undefined;

/** How far this instance's wasm has grown past what a fresh one would hold. */
function wasmGrowthMb(): number {
  const subduction = wasmBytes(SUBDUCTION_WASM);
  subductionBaseline ??= subduction;
  const bytes =
    wasmBytes(AUTOMERGE_WASM) + Math.max(0, subduction - subductionBaseline);
  return Math.round(bytes / 1048576);
}

function recycleIfHolding() {
  if (handoffsInFlight > 0 || draining) return;
  const mb = wasmGrowthMb();
  if (mb <= RECYCLE_AT_MB) return;
  control.restart(
    `recycling: wasm memory has grown by ${mb}MB with nothing to resolve`
  );
}

async function evictLoaded() {
  const repo = await repoPromise?.catch(() => null);
  if (!repo) return;
  const ids = Object.keys(repo.handles) as DocumentId[];
  log(
    `evicting ${ids.length} document(s) after ${EVICT_IDLE_MS}ms without a handoff`
  );
  for (const id of ids) {
    if (handoffsInFlight > 0) return;
    await repo.removeFromCache(id);
  }
}

async function handleHandoffRequest(message: HandoffRequestMessage) {
  const { id, request } = message;

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

  handoffStarted();
  try {
    await respondToHandoff(message, handoff);
  } finally {
    handoffFinished();
  }
}

function resolveWithin(handoff: URL): Promise<Response> {
  const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  return Promise.race([
    resolveAutomergeUrl(handoff, signal),
    impatience(RESOLVE_TIMEOUT_MS),
  ]);
}

/** Lookups of a url without heads in flight, by that url. */
const latestLookups = new Map<string, Promise<Response>>();

/**
 * Resolve `handoff`, sharing the lookup with any already in flight for the
 * same url without heads. Every tab's ModuleWatcher asks for each package's
 * latest heads, again each time it changes, and none of it is cached, since
 * the answer moves; on a busy worker those pile up into one full resolve
 * each. One that joins late gets the shared lookup's answer, or its timeout,
 * a little sooner than it would have its own.
 */
function resolveHandoff(handoff: URL): Promise<Response> {
  const [maybeAutomergeUrl] = handoff.href.split("/");
  if (
    !isValidAutomergeUrl(maybeAutomergeUrl) ||
    parseAutomergeUrl(maybeAutomergeUrl).heads
  ) {
    return resolveWithin(handoff);
  }
  let lookup = latestLookups.get(handoff.href);
  if (!lookup) {
    lookup = resolveWithin(handoff).finally(() => {
      latestLookups.delete(handoff.href);
    });
    latestLookups.set(handoff.href, lookup);
  }
  // A redirect, so there's no body to share; each reply gets its own anyway.
  return lookup.then((response) => response.clone());
}

async function respondToHandoff(message: HandoffRequestMessage, handoff: URL) {
  const { id, cachename, request } = message;

  let response: Response;
  try {
    log(`resolving handoff ${id} for ${handoff}`);
    response = await resolveHandoff(handoff);
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
    const immutable =
      CACHEABLE_STATUSES.includes(response.status) &&
      !/(^|,)\s*no-store(\s*,|$)/.test(
        response.headers.get("cache-control") ?? ""
      );
    if (!immutable) {
      // Errors, redirects and the like go back inline for the service worker to
      // serve directly. Mutable responses aren't cached because the same URL
      // can resolve to different content later.
      log(`responding inline to ${request.url} with ${response.status}`);
      handoffChannel.postMessage({
        id,
        type: "response",
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: response.body
            ? new Uint8Array(await response.arrayBuffer())
            : undefined,
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

// How long a restart waits for in-flight handoffs before closing anyway.
const DRAIN_HANDOFFS_MS = 3_000;
let draining = false;

// Stop taking new handoffs and let the ones in flight finish. The service
// worker keeps every unanswered handoff pending and re-broadcasts them when
// our replacement announces itself online, so nothing dropped here is lost —
// waiting is a courtesy to requests that are nearly done, not a requirement.
async function drainForRestart(): Promise<void> {
  draining = true;
  const deadline = Date.now() + DRAIN_HANDOFFS_MS;
  while (handoffsInFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (handoffsInFlight > 0) {
    console.warn(
      `[lifecycle] closing with ${handoffsInFlight} handoff(s) in flight; the service worker will re-send them`
    );
  }
  const repo = await repoPromise?.catch(() => null);
  await repo?.flush();
  await saveLoaded().catch((error) =>
    console.warn("couldn't keep the package records for the next instance", error)
  );
  const node = await syncNodePromise?.catch(() => null);
  await node?.shutdown();
}

handoffChannel.addEventListener("message", (event) => {
  if (event.data?.type !== "request") return;
  if (draining) {
    log(`ignoring handoff ${event.data.id} while restarting`);
    return;
  }
  // The previous instance is still answering; once it's gone, `online` gets
  // the service worker to send us whatever it left unanswered.
  if (!holdingLock) return;
  void handleHandoffRequest(event.data as HandoffRequestMessage);
});

// Announce ourselves so the service worker can re-broadcast handoff requests
// sent while we were booting, or left by the instance before us.
void control.holding.then(() =>
  handoffChannel.postMessage({ type: "online" } satisfies HandoffOnlineMessage)
);

// ── Measuring packages ─────────────────────────────────────────────────

/**
 * What resolves have loaded of each package, by its root doc: each document
 * measured when it was loaded (again only if its heads have moved), and the
 * paths asked for through it.
 */
const loadedByPackage = new Map<
  DocumentId,
  Map<
    DocumentId,
    {
      heads: string;
      measured: PackageMemoryDocument;
      through: Set<string>;
      /** It's the file a path ended on, not a folder on the way. */
      file: boolean;
    }
  >
>();

/** Branches docs followed to their default branch, which holds the package. */
const branchOf = new Map<DocumentId, DocumentId>();

// What's been loaded outlives the instance: a restart (a recycle, or a new
// build) saves it for the replacement, which resolves from the service
// worker's cache rather than loading the packages again.
const LOADED_KEY = "/loaded-by-package";

type SavedLoaded = {
  packages: Array<
    [
      DocumentId,
      Array<
        [
          DocumentId,
          {
            heads: string;
            measured: PackageMemoryDocument;
            through: string[];
            file: boolean;
          },
        ]
      >,
    ]
  >;
  branches: Array<[DocumentId, DocumentId]>;
};

async function saveLoaded() {
  await restored;
  const saved: SavedLoaded = {
    packages: [...loadedByPackage].map(([packageId, documents]) => [
      packageId,
      [...documents].map(([id, entry]) => [
        id,
        { ...entry, through: [...entry.through] },
      ]),
    ]),
    branches: [...branchOf],
  };
  const cache = await caches.open(LOADED_CACHE);
  await cache.put(LOADED_KEY, new Response(JSON.stringify(saved)));
}

/** Settles once what the instance before saved has been taken back. */
const restored: Promise<void> = (async () => {
  try {
    const cache = await caches.open(LOADED_CACHE);
    const response = await cache.match(LOADED_KEY);
    if (!response) return;
    const saved = (await response.json()) as SavedLoaded;
    for (const [packageId, documents] of saved.packages) {
      const into = loadedByPackage.get(packageId) ?? new Map();
      for (const [id, entry] of documents) {
        // Loaded since by this instance: that's newer.
        if (into.has(id)) continue;
        into.set(id, { ...entry, through: new Set(entry.through) });
      }
      loadedByPackage.set(packageId, into);
    }
    for (const [from, to] of saved.branches) {
      if (!branchOf.has(from)) branchOf.set(from, to);
    }
  } catch (error) {
    console.warn("couldn't take back the package records", error);
  }
})();

/** `handles` were found in turn resolving `path`: the root first, the file last. */
function recordLoaded(
  packageId: DocumentId,
  handles: DocHandle<unknown>[],
  path: string
) {
  let documents = loadedByPackage.get(packageId);
  if (!documents) loadedByPackage.set(packageId, (documents = new Map()));
  handles.forEach((handle, i) => {
    const heads = handle.heads().join(",");
    let entry = documents.get(handle.documentId);
    if (!entry || entry.heads !== heads) {
      entry = {
        heads,
        measured: measureDocument("", handle),
        through: entry?.through ?? new Set(),
        file: entry?.file ?? false,
      };
      documents.set(handle.documentId, entry);
    }
    entry.through.add(path);
    if (i > 0 && i === handles.length - 1) entry.file = true;
  });
}

/** What's been loaded of the package at `url`, root first. */
function loadedOf(url: string): PackageMemoryDocument[] {
  if (!isValidAutomergeUrl(url)) return [];
  const { documentId } = parseAutomergeUrl(url);
  const packageId = branchOf.get(documentId) ?? documentId;
  return [...(loadedByPackage.get(packageId) ?? [])].map(([id, entry]) => {
    const paths = [...entry.through];
    const path =
      id === packageId
        ? ""
        : entry.file
          ? paths[0]
          : sharedDirectory(paths);
    return { ...entry.measured, path };
  });
}

/** The directory every one of `paths` is in. */
function sharedDirectory(paths: string[]): string {
  const dirs = paths.map((path) => path.split("/").slice(0, -1));
  const shared = dirs[0] ?? [];
  let n = shared.length;
  for (const dir of dirs) {
    while (n > 0 && dir.slice(0, n).join("/") !== shared.slice(0, n).join("/")) n--;
  }
  return shared.slice(0, n).join("/");
}

const MEASURE_TIMEOUT_MS = 300_000;
// Most of a package's documents (READMEs, images) aren't stored here until
// it's measured, since modules never import them; one that doesn't turn up
// in this long is reported as unavailable.
const MEASURE_FIND_TIMEOUT_MS = 15_000;
const packageMemoryChannel = new BroadcastChannel(PACKAGE_MEMORY_CHANNEL);

// One package at a time, so measuring them all doesn't load them all at once.
let measuring: Promise<void> = Promise.resolve();

packageMemoryChannel.addEventListener("message", (event) => {
  const message = event.data as PackageMemoryRequestMessage;
  // Only one instance answers: the one holding the lock.
  if (message?.type !== "request" || draining || !holdingLock) return;
  packageMemoryChannel.postMessage({
    id: message.id,
    type: "accepted",
  } satisfies PackageMemoryAcceptedMessage);
  if (!message.walk) {
    void restored.then(() =>
      packageMemoryChannel.postMessage({
        id: message.id,
        type: "reply",
        documents: loadedOf(message.url),
      } satisfies PackageMemoryReplyMessage)
    );
    return;
  }
  measuring = measuring.then(() => replyWithPackageMemory(message));
});

async function replyWithPackageMemory({ id, url }: PackageMemoryRequestMessage) {
  const documents: PackageMemoryDocument[] = [];
  let error: string | undefined;
  // Holds off the eviction of everything loaded, as a handoff does; the
  // documents measured are let go one at a time instead.
  handoffStarted();
  try {
    await measurePackage(url, (document) => documents.push(document));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    handoffFinished();
  }
  packageMemoryChannel.postMessage({
    id,
    type: "reply",
    documents,
    error,
  } satisfies PackageMemoryReplyMessage);
}

/**
 * Find the package at `url` the way a resolve does, then each of its
 * documents in turn, letting each go once it's measured unless a resolve is
 * under way, which may be using it too. What's left goes with the rest once
 * handoffs stop.
 */
async function measurePackage(
  url: string,
  found: (document: PackageMemoryDocument) => void
) {
  if (!isValidAutomergeUrl(url)) throw new Error(`not an automerge url: ${url}`);
  const repo = await getRepo();
  const signal = AbortSignal.timeout(MEASURE_TIMEOUT_MS);
  const release = async (id: DocumentId) => {
    // This measurement is the only handoff in flight.
    if (handoffsInFlight === 1 && repo.handles[id]) {
      await repo.removeFromCache(id);
    }
  };
  const find = <T>(id: AnyDocumentId) => {
    return repo.find<T>(id, {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(MEASURE_FIND_TIMEOUT_MS),
      ]),
    });
  };
  const tracked: Repo = Object.create(repo, { find: { value: find } });
  const { documentId, heads, hexHeads } = parseAutomergeUrl(url);
  let root = await find(stringifyAutomergeUrl({ documentId }));
  if (heads) {
    if (!(await waitForHeads(root, hexHeads ?? [], signal))) {
      throw new Error(`heads not found for ${url}`);
    }
    root = root.view(heads);
  } else {
    await caughtUpWithPeers(repo, root, signal);
    const branch = getDefaultBranch(root.doc());
    if (branch) {
      await release(root.documentId);
      root = await find(branch);
      await caughtUpWithPeers(repo, root, signal);
    }
  }
  for await (const document of packageDocuments(tracked, root)) {
    if ("error" in document) {
      const { path, url, error } = document;
      found({
        url,
        path,
        ops: 0,
        changes: 0,
        largestChange: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    found(measureDocument(document.path, document.handle));
    await release(document.handle.documentId);
  }
}

function measureDocument(
  path: string,
  handle: DocHandle<unknown>
): PackageMemoryDocument {
  const doc = handle.fullDoc();
  const { numOps, numChanges } = stats(doc);
  let largestChange = 0;
  for (const { startOp, maxOp } of getChangesMetaSince(doc, [])) {
    largestChange = Math.max(largestChange, maxOp - startOp + 1);
  }
  const content = (doc as { content?: unknown } | undefined)?.content;
  return {
    url: handle.url,
    path,
    ops: numOps,
    changes: numChanges,
    largestChange,
    content:
      typeof content === "string"
        ? { kind: "text", length: content.length }
        : isImmutableString(content)
          ? { kind: "immutable", length: String(content).length }
          : content instanceof Uint8Array
            ? { kind: "bytes", length: content.byteLength }
            : undefined,
  };
}
