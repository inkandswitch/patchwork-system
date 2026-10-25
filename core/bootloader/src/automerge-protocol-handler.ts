// The Repo that resolves `automerge:` URLs for the service worker when no tab
// can, in a SharedWorker: one instance serves every tab and lives as long as
// any tab does. The worker's script is automerge-protocol-handler-worker.ts,
// which takes the lock and then imports this.
//
// It is a node like any tab's: the same IndexedDB, its own sync-server socket,
// and the storage channel to the tabs. Resolving requests is its whole job.
// When the service worker can't get a tab to resolve a request that looks like
// a URL encoded URL, it broadcasts a HandoffRequestMessage on HANDOFF_CHANNEL;
// we resolve the automerge URL, write the response into the service worker's
// cache (keyed by a Request reconstructed to match the one it's holding), and
// reply on the same channel.
import { initializeWasm } from "@automerge/automerge/slim";
// eslint-disable-next-line
// @ts-ignore — the default init is a wasm-bindgen runtime helper not in the .d.ts
import initSubduction from "@automerge/automerge-subduction/slim";

import {
  Repo,
  type DocumentId,
  type PeerId,
} from "@automerge/automerge-repo/slim";

import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import type {
  AutomergeRepoKeyhive,
  SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";

import { loadOrCreateSigner } from "./signer.js";
import { keyhiveStorageName, storagePrefix } from "./storage.js";
import { startWorkerControl } from "./worker-control.js";
import { AUTOMERGE_WASM, SUBDUCTION_WASM } from "./emitted.js";
import { createResolver } from "./resolver.js";
import {
  AUTOMERGE_WORKER_LOCK,
  HANDOFF_CHANNEL,
  type HandoffOnlineMessage,
  type HandoffRequestMessage,
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

const control = startWorkerControl("automerge-protocol-handler-worker", {
  onRestart: drainForRestart,
  // Held only so the tabs and the service worker can tell whether this
  // instance is still around; nothing here waits for it.
  lock: AUTOMERGE_WORKER_LOCK,
});
const log = control.log;

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
    subductionWebsocketEndpoints: [syncServer.url],
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
  const { hive, repo } = await initializeAutomergeRepoKeyhive({
    // ARK injects an `idFactory` deriving document ids from keyhive. A site
    // can opt out of it with `keyhive: { useIdFactory: false }`.
    createRepo: ({ idFactory, ...config }) =>
      new Repo(
        syncServer.useIdFactory === false ? config : { ...config, idFactory }
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
      subductionWebsocketEndpoints: [syncServer.url],
      headsChannel: `${storagePrefix}-heads`,
      enableRemoteHeadsGossiping: true,
    },
  });

  hive.networkAdapter.whenReady().then(() => {
    (hive.networkAdapter as any).syncKeyhive();
  });

  return { repo, hive };
}

// ── Answering handoffs ─────────────────────────────────────────────────
// What nothing else could answer: the service worker asks the tab that made a
// request first, then any other tab, and broadcasts it here only when none of
// them can (one still booting, one from an older build, a site that brings
// its own Repo).

const resolver = createResolver(getRepo, log);
const handoffChannel = new BroadcastChannel(HANDOFF_CHANNEL);

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
// new build: tabs spawn the replacement, the service worker re-sends any
// handoff still unanswered, and what was resolved is in its cache, so the
// replacement doesn't load it all again. Only the resolver goes with it: every
// tab is its own node, with its own socket.

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

/** How much memory this instance's wasm holds. */
function wasmGrowthMb(): number {
  const bytes = wasmBytes(AUTOMERGE_WASM) + wasmBytes(SUBDUCTION_WASM);
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
  handoffStarted();
  try {
    const reply = await resolver.answer(message);
    // Other handlers may be listening on the channel for other schemes, so
    // stay quiet rather than clobbering their reply with an error.
    if (!reply) {
      log(`ignoring handoff ${message.id} for a url that isn't automerge:`);
      return;
    }
    handoffChannel.postMessage(reply);
  } finally {
    handoffFinished();
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
}

handoffChannel.addEventListener("message", (event) => {
  if (event.data?.type !== "request") return;
  if (draining) {
    log(`ignoring handoff ${event.data.id} while restarting`);
    return;
  }
  void handleHandoffRequest(event.data as HandoffRequestMessage);
});

// Announce ourselves so the service worker can re-broadcast handoff requests
// sent while we were booting, or left by the instance before us.
handoffChannel.postMessage({ type: "online" } satisfies HandoffOnlineMessage);
