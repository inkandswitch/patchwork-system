// See docs/bootloader.html#resolver and #hub.
//
// The automerge worker: the origin's one node (see hub/hub.ts). It holds the
// sedimentree backend every tab's Repo runs on, through a port each tab hands
// it, and its own Repo answers the service worker's handoffs no tab could.
import { Repo, type DocumentId } from "@automerge/automerge-repo/slim";

import { storagePrefix } from "./storage.js";
import { startWorkerControl } from "./worker-control.js";
import { createResolver } from "./resolver.js";
import { createHub, type Hub, type SyncServerConfig } from "./hub/hub.js";
import { initHubWasm, wasmGrowthMb, watchWasmMemories } from "./wasm.js";
import {
  AUTOMERGE_WORKER_LOCK,
  HANDOFF_CHANNEL,
  type HandoffOnlineMessage,
  type HandoffRequestMessage,
} from "./types.js";

declare const __SYNC_SERVER__: SyncServerConfig;

const syncServer: SyncServerConfig =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };

const control = startWorkerControl("automerge-protocol-handler-worker", {
  onRestart: drainForRestart,
  // A tab handing us the port its Repo's backend talks to us on.
  onMessage(data) {
    if (data?.type === "hub" && data.port instanceof MessagePort) {
      connectTab(data.port);
    }
  },
  // Held only so the tabs and the service worker can tell whether this
  // instance is still around; nothing here waits for it.
  lock: AUTOMERGE_WORKER_LOCK,
});
const log = control.log;

let hubPromise: Promise<Hub> | null = null;

function getHub(): Promise<Hub> {
  if (!hubPromise) {
    hubPromise = buildHub();
    // Nothing resolves without it (the wasm fetch failed, say): start again
    // from scratch, as a new instance.
    hubPromise.catch((error) => {
      hubPromise = null;
      control.fail("the automerge worker's hub failed to start", error);
    });
  }
  return hubPromise;
}

const getRepo = (): Promise<Repo> => getHub().then((hub) => hub.repo);

let builtHub: Hub | undefined;

// For the console. The hub is built once a tab connects or something has to
// be resolved, so before then reading `repo` starts building it and gives its
// promise: `await repo` works either way.
Object.defineProperty(self, "repo", {
  configurable: true,
  get: () => builtHub?.repo ?? getRepo(),
});
Object.defineProperty(self, "hub", {
  configurable: true,
  get: () => builtHub ?? getHub(),
});

async function buildHub(): Promise<Hub> {
  watchWasmMemories();
  log("fetching wasm");
  await initHubWasm({ keyhive: !!syncServer.keyhive });
  log("wasm initialized");
  const hub = await createHub({ syncServer, storagePrefix, log });
  builtHub = hub;
  return hub;
}

// Tabs connected to the hub. While there are any this instance doesn't
// recycle itself: every tab's sessions would have to open again.
let tabs = 0;

function connectTab(port: MessagePort) {
  tabs++;
  clearTimeout(recycleTimer);
  getHub().then(
    (hub) =>
      hub.serve(port, () => {
        tabs--;
        scheduleRecycle();
      }),
    (error) => {
      tabs--;
      console.error("couldn't serve a tab", error);
      port.close();
    }
  );
}

// Handoffs are what nothing else could answer: the service worker asks the
// tab that made a request first, then any other tab, and broadcasts it here only when none of
// them can (one still booting, one from an older build, a site that brings
// its own Repo).

const resolver = createResolver(
  getRepo,
  log,
  () => builtHub?.network.status === "connected"
);
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
  scheduleRecycle();
}

function scheduleRecycle() {
  clearTimeout(recycleTimer);
  recycleTimer = setTimeout(recycleIfHolding, RECYCLE_IDLE_MS);
}

// wasm memory never shrinks, so a grown instance restarts once handoffs stop.
// See docs/bootloader.html#recycling.

const RECYCLE_AT_MB = 64;
const RECYCLE_IDLE_MS = 15_000;
let recycleTimer: ReturnType<typeof setTimeout> | undefined;

function recycleIfHolding() {
  if (handoffsInFlight > 0 || tabs > 0 || draining) return;
  const mb = wasmGrowthMb();
  if (mb <= RECYCLE_AT_MB) return;
  control.restart(
    `recycling: wasm memory has grown by ${mb}MB with nothing to resolve`
  );
}

async function evictLoaded() {
  const repo = (await hubPromise?.catch(() => null))?.repo;
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
  const hub = await hubPromise?.catch(() => null);
  // tabs' writes as well as the worker's own
  await hub?.backend.flush();
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
