import type {
  SetupServiceWorkerOptions,
  SetupServiceWorkerResult,
  SyncStateDocMessage,
} from "./types.js";
import {
  readClassicSyncServer,
  DEFAULT_CLASSIC_SYNC_SERVER,
} from "./sync-config.js";
import debug from "debug";
import {
  donatePort,
  isWorkerErrorMessage,
} from "@automerge/automerge-repo/worker-port";
import {
  forwardWorkerConsole,
  lifecycleLog,
  sharedWorkerHandle,
} from "./shared-worker.js";

export { lifecycleLog };

const serviceWorkerDebugging = debug.enabled("patchwork:serviceworker");
const workerDebugging = debug.enabled("patchwork:automergeworker");

// The version is cleared on every boot, so the steady state is
// DEFAULT_CACHE_NAME. bumpServiceWorkerCache is a dev escape hatch: it moves
// the worker to a throwaway cache now, and the next boot both reverts the name
// and (via the worker's activate handler) deletes the throwaway.
const CACHE_VERSION_KEY = "patchworkServiceWorkerCacheVersion";
const DEFAULT_CACHE_NAME = "patchwork";

function currentCacheName(): string {
  return localStorage.getItem(CACHE_VERSION_KEY) ?? DEFAULT_CACHE_NAME;
}

function configureServiceWorker(sw: ServiceWorker | null) {
  if (!sw) return;
  sw.postMessage({ type: "debug", debug: serviceWorkerDebugging });
  sw.postMessage({ type: "cachename", cachename: currentCacheName() });
}

export function bumpServiceWorkerCache(
  sw: ServiceWorker | null = navigator.serviceWorker.controller
) {
  if (!sw) throw new Error("no service worker!");
  localStorage.setItem(CACHE_VERSION_KEY, Date.now().toString(36));
  sw.postMessage({ type: "cachename", cachename: currentCacheName() });
}

// The service worker has no localStorage, so it can't read the debug config —
// it always emits lifecycle markers and forwards them here to be filtered.
let logForwardingInstalled = false;
function installServiceWorkerLogForwarding(): void {
  if (logForwardingInstalled) return;
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  logForwardingInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type !== "sw-lifecycle") return;
    lifecycleLog("[service-worker] %s", event.data.msg);
  });
}

// ── The two shared workers ─────────────────────────────────────────────
//
// The subduction worker owns this origin's storage and the link to the sync
// server; tabs are peers of it. The automerge worker is a storageless Repo
// whose only job is resolving `automerge:` URLs for the service worker. A
// SharedWorker can neither spawn nor connect to another SharedWorker, so this
// tab brokers the link between them: it opens a port on the subduction worker
// and donates it.

let subductionWorkerPath = "/subduction-worker.js";
let automergeWorkerPath = "/automerge-worker.js";
let nextPortId = 0;

const subductionWorker = sharedWorkerHandle(
  "patchwork-subduction",
  () => subductionWorkerPath,
  {
    debugging: workerDebugging,
    onMessage(event) {
      const data = event.data;
      if (data?.type === "sync-state") {
        dispatchSyncState(data as SyncStateDocMessage);
        return;
      }
      forwardWorkerConsole("subduction-worker", data);
    },
  }
);

const automergeWorker = sharedWorkerHandle(
  "patchwork-automerge",
  () => automergeWorkerPath,
  {
    debugging: workerDebugging,
    onMessage(event) {
      const data = event.data;
      // Crash/skew reports relayed over the port-provision protocol (e.g. a
      // mismatch from a stale SW-cached worker chunk). These otherwise only
      // exist in chrome://inspect.
      if (isWorkerErrorMessage(data)) {
        console.error("[automerge-worker]", data);
        return;
      }
      forwardWorkerConsole("automerge-worker", data);
    },
    onSpawn(worker) {
      // Its Repo asks for this link on first use; `eager` would open a port
      // before the worker had booted its wasm.
      donatePort(worker.port, () => openPort(), {
        target: "subduction-link",
        eager: false,
      });
    },
  }
);

// The resolver's link ends in a worker that no longer exists, and a dead
// SharedWorker leaves its ports silent rather than closed, so it needs telling.
subductionWorker.onRecreated(() => {
  for (const documentId of syncStateListeners.keys()) {
    subductionWorker.post({ type: "sync-sub", documentId });
  }
  automergeWorker.post({ type: "link-lost" });
});

export function getAutomergeWorker(): SharedWorker {
  return automergeWorker.get();
}

export function getSubductionWorker(): SharedWorker {
  return subductionWorker.get();
}

/**
 * Wait for the worker to confirm it has accepted the port. Nothing on the port
 * itself says so: the far side has to fetch wasm and build its node first.
 */
function awaitPortReady(control: MessagePort, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      control.removeEventListener("message", listener);
    };
    const listener = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      if (event.data.type === "port-ready") {
        cleanup();
        resolve();
      } else if (event.data.type === "port-failed") {
        cleanup();
        reject(new Error(`subduction worker init failed: ${event.data.error}`));
      }
    };
    control.addEventListener("message", listener);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("subduction worker port-ready timeout"));
    }, 30_000);
  });
}

/** Open a Subduction port to the subduction worker, once it says it is ready. */
export async function openPort(): Promise<MessagePort> {
  const id = ++nextPortId;
  const worker = subductionWorker.get();
  const ready = awaitPortReady(worker.port, id);
  const { port1, port2 } = new MessageChannel();
  worker.port.postMessage({ type: "port", id }, [port2]);
  try {
    await ready;
  } catch (err) {
    // Surface the problem and let the rest of the site come up rather than
    // hanging on a blank page.
    console.warn(
      "proceeding without worker ready ack:",
      err instanceof Error ? err.message : err
    );
  }
  return port1;
}

// ── Sync state ─────────────────────────────────────────────────────────
// Ref-counted locally so several callers in this tab can watch the same doc
// with a single worker subscription.

type SyncStateListener = (update: SyncStateDocMessage) => void;
const syncStateListeners = new Map<string, Set<SyncStateListener>>();

function dispatchSyncState(update: SyncStateDocMessage): void {
  for (const listener of syncStateListeners.get(update.documentId) ?? []) {
    try {
      listener(update);
    } catch (err) {
      console.error("sync-state listener threw", err);
    }
  }
}

export function subscribeSyncState(
  documentId: string,
  listener: SyncStateListener
): () => void {
  let listeners = syncStateListeners.get(documentId);
  if (!listeners) {
    syncStateListeners.set(documentId, (listeners = new Set()));
    subductionWorker.post({ type: "sync-sub", documentId });
  }
  listeners.add(listener);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const set = syncStateListeners.get(documentId);
    if (!set) return;
    set.delete(listener);
    if (set.size > 0) return;
    syncStateListeners.delete(documentId);
    subductionWorker.post({ type: "sync-unsub", documentId });
  };
}

export function connectClassicSync(
  server: string = readClassicSyncServer()
): Promise<void> {
  const url = server.trim() || DEFAULT_CLASSIC_SYNC_SERVER;
  if (!/^wss?:\/\//.test(url)) {
    return Promise.reject(
      new Error(`invalid classic sync server URL: ${server}`)
    );
  }

  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port1.close();
      reject(new Error("connect-classic-sync timeout"));
    }, 30_000);
    port1.onmessage = (event) => {
      clearTimeout(timeout);
      port1.close();
      if (event.data?.type === "connect-classic-sync-ready") resolve();
      else
        reject(new Error(event.data?.error ?? "connect-classic-sync failed"));
    };
    automergeWorker.post({ type: "connect-classic-sync", server: url }, [
      port2,
    ]);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────

function waitForActive(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (reg.active) return Promise.resolve(reg.active);
  const worker = reg.installing || reg.waiting;
  if (!worker) {
    return Promise.reject(new Error("no service worker in registration"));
  }
  return new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve(worker);
      // Without this the promise never settles when an install fails.
      else if (worker.state === "redundant") {
        reject(new Error("service worker became redundant before activating"));
      }
    });
  });
}

export default async function setupServiceWorker(
  options?: SetupServiceWorkerOptions
): Promise<SetupServiceWorkerResult> {
  // Attach the log bridge first so the controlling worker's boot/install/
  // activate markers are rendered here.
  installServiceWorkerLogForwarding();
  localStorage.removeItem(CACHE_VERSION_KEY);

  // Cache growth can otherwise trip origin-wide eviction, which would take the
  // Automerge IndexedDB — the user's documents — with it. Chrome/Safari decide
  // silently from site engagement; Firefox may prompt. Denial just means
  // default eviction.
  void navigator.storage?.persist?.().catch(() => {});

  if (options?.workerPath) automergeWorkerPath = options.workerPath;
  if (options?.subductionWorkerPath) {
    subductionWorkerPath = options.subductionWorkerPath;
  }

  // Start both now so they boot wasm while the service worker installs.
  const shared = subductionWorker.get();
  automergeWorker.get();

  const reg = await navigator.serviceWorker.register(
    options?.path ?? "/service-worker.js",
    { type: "module" }
  );

  const active =
    reg.installing || reg.waiting ? await waitForActive(reg) : reg.active;
  configureServiceWorker(active);

  // No controller means the page loaded without a service worker — a first-time
  // install or a hard reload. Wait for it so the app boots with the worker in
  // control of generated fetches.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => resolve(),
        { once: true }
      );
    });
  }

  // A replacement worker boots with the default cache name, so reconfigure
  // whenever a new one takes control.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    configureServiceWorker(navigator.serviceWorker.controller);
  });

  console.log(
    "service worker alive, loading %c patchwork system ",
    "background: #fcf2f0; color: #333; border: 2px solid; border-radius: 4px"
  );

  return {
    shared,
    connectClassicSync,
    subscribeSyncState,
    openPort,
    onRecreated: subductionWorker.onRecreated,
  };
}

(window as any).bumpServiceWorkerCache = bumpServiceWorkerCache;
