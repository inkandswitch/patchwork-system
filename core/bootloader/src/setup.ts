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

const serviceWorkerDebugging = debug.enabled("patchwork:serviceworker");
const workerDebugging = debug.enabled("patchwork:automergeworker");

export const lifecycleLog = debug("patchwork:lifecycle");

function describeErrorEvent(event: Event): string {
  const error = event as ErrorEvent;
  const where = error.filename
    ? ` (${error.filename}:${error.lineno}:${error.colno})`
    : "";
  return `${error.message || String(event)}${where}`;
}

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

// The automerge repo lives in a SharedWorker. one instance serves every
// tab. Browsers might kill a SharedWorker under memory pressure, so we
// heartbeat it and rebuild everything if it dies.

let automergeWorkerPath = "/automerge-worker.js";
let automergeWorker: SharedWorker | undefined;
// A repo port opened against instance N is stale once instance N+1 exists — its
// channel ends in a dead worker — so deliveries are guarded on generation.
let workerGeneration = 0;
let disposeWorkerDeathDetection: (() => void) | undefined;
const workerRecreatedListeners = new Set<() => void>();
let recoveringWorker = false;
let lastWorkerRecoveryAt = 0;
// Below this spacing, skip: if the fresh worker is dead too, its own heartbeat
// re-triggers recovery later rather than spinning in a tight loop.
const RECOVERY_MIN_INTERVAL_MS = 15_000;
let nextRepoChannelId = 0;

// Chrome can't spawn workers inside a SharedWorker, so each tab offers this
// proxy's port to the automerge worker, which requests one via its port
// provider. Being a SharedWorker itself, the proxy — and the donated
// worker↔worker port — outlives the donor tab.
const SUBDUCTION_IO_WORKER_URL =
  "/packages/@automerge/automerge-repo/subduction-websocket-worker-shared.js";

export function getAutomergeWorker(): SharedWorker {
  if (automergeWorker) return automergeWorker;

  workerGeneration++;
  const worker = new SharedWorker(automergeWorkerPath, {
    name: "patchwork-automerge",
    type: "module",
  });
  automergeWorker = worker;

  // Fires when a message can't be structured-deserialized. Silent otherwise:
  // the message is dropped, which looks identical to a worker that never
  // replied.
  worker.port.addEventListener("messageerror", (event) => {
    console.error(
      "[automerge-worker] undeserializable message from worker:",
      event
    );
  });
  // Control replies come back on this port, and we listen with
  // addEventListener rather than onmessage, so it needs start().
  worker.port.start();
  worker.port.addEventListener("message", handleWorkerMessage);
  worker.port.postMessage({ type: "debug", debug: workerDebugging });

  donatePort(worker.port, createSubductionIoPort);
  disposeWorkerDeathDetection = installWorkerDeathDetection(worker);
  return worker;
}

function handleWorkerMessage(event: MessageEvent): void {
  const data = event.data;

  if (data?.type === "sync-state") {
    dispatchSyncState(data as SyncStateDocMessage);
    return;
  }

  // Crash/skew reports relayed from the subduction io proxy (e.g. a protocol
  // mismatch from a stale SW-cached worker chunk). These otherwise only exist
  // in chrome://inspect.
  if (isWorkerErrorMessage(data)) {
    console.error("[subduction-io]", data);
    return;
  }

  if (data?.type !== "console") return;
  const { level, args } = data;
  if (
    !lifecycleLog.enabled &&
    typeof args?.[0] === "string" &&
    args[0].includes("[lifecycle]")
  ) {
    return;
  }
  const write = (console as any)[level] ?? console.log;
  // The worker's logs carry %c directives in args[0] with CSS in the following
  // args, so the tag has to go inside the format string or the CSS prints raw.
  if (typeof args[0] === "string") {
    write(`[automerge-worker] ${args[0]}`, ...args.slice(1));
  } else {
    write("[automerge-worker]", ...args);
  }
}

function createSubductionIoPort(): MessagePort {
  const io = new SharedWorker(SUBDUCTION_IO_WORKER_URL, {
    type: "module",
    name: "subduction-websocket",
  });
  // This worker carries the websocket to the sync server, so a load failure
  // stops sync with no other symptom.
  io.addEventListener("error", (event) => {
    console.error(
      `[subduction-io] failed to load/run ${SUBDUCTION_IO_WORKER_URL}:`,
      describeErrorEvent(event)
    );
  });
  io.port.addEventListener("messageerror", (event) => {
    console.error("[subduction-io] undeserializable message:", event);
  });
  return io.port;
}

/**
 * Build a replacement worker and re-wire everything a live tab holds against
 * it: console forwarding and port donation (both re-done by
 * getAutomergeWorker) and the per-doc sync-state subscriptions. The new
 * instance boots with cold state. Listeners are told so they can reopen
 * whatever they had on the dead one.
 */
async function recoverAutomergeWorker(
  reason: string,
  deadWorker: SharedWorker
): Promise<void> {
  if (deadWorker !== automergeWorker) return;
  if (recoveringWorker) return;
  const now = Date.now();
  if (now - lastWorkerRecoveryAt < RECOVERY_MIN_INTERVAL_MS) return;
  recoveringWorker = true;
  lastWorkerRecoveryAt = now;
  lifecycleLog("recreating the automerge SharedWorker (%s)", reason);

  try {
    disposeWorkerDeathDetection?.();
    disposeWorkerDeathDetection = undefined;
    automergeWorker = undefined;
    try {
      deadWorker.port.close();
    } catch {}

    const fresh = getAutomergeWorker();
    for (const documentId of syncStateListeners.keys()) {
      fresh.port.postMessage({ type: "sync-sub", documentId });
    }
    for (const listener of workerRecreatedListeners) {
      try {
        listener();
      } catch (err) {
        console.error("worker-recreated listener threw", err);
      }
    }
  } finally {
    recoveringWorker = false;
  }
}

// A silent port is not proof of death: the worker may still be evaluating its
// module graph, or be busy with wasm/sync work. In both cases every queued
// message — including the repo ports the network adapters ride on — is
// delivered once it catches up, and tearing the port down would lose them. So
// silence only starts a non-destructive probe: a second connection to the same
// instance. Only if the probe gets a `hello` while this port stays silent do we
// know the instance is alive but our port is stranded, and recover.
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 25_000;
// An idle worker hellos within milliseconds of connecting, so before first
// contact the budget is tighter — probing early rescues stranded boots fast.
const FIRST_CONTACT_TIMEOUT_MS = 4_000;
// After a slow boot both connections hello at roughly the same moment and
// cross-port delivery order isn't guaranteed, so give the suspect this long to
// also speak before concluding it's stranded.
const PROBE_GRACE_MS = 500;

function installWorkerDeathDetection(worker: SharedWorker): () => void {
  let instanceId: string | undefined;
  let lastHeardAt = Date.now();
  let warnedUnresponsive = false;
  let warnedSendFailed = false;
  let disposed = false;
  let probe: SharedWorker | undefined;
  let seq = 0;

  const closeProbe = () => {
    if (!probe) return;
    try {
      probe.port.close();
    } catch {}
    probe = undefined;
  };

  worker.port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data?.type !== "hello" && data?.type !== "pong") return;
    lastHeardAt = Date.now();
    warnedUnresponsive = false;
    closeProbe();
    if (instanceId === undefined) {
      instanceId = data.instanceId;
      lifecycleLog(
        "automerge SharedWorker instance %s (via %s)",
        data.instanceId,
        data.type
      );
    } else if (data.instanceId && data.instanceId !== instanceId) {
      lifecycleLog(
        "automerge SharedWorker instance changed (instance %s, was %s)",
        data.instanceId,
        instanceId
      );
      instanceId = data.instanceId;
    }
  });

  worker.port.addEventListener("close", () => {
    if (disposed) return;
    lifecycleLog("automerge SharedWorker control port closed");
    void recoverAutomergeWorker("control port closed", worker);
  });

  // Not gated on the debug namespace: a worker that fails to load never replies
  // to anything, and this is the only signal that says so.
  worker.addEventListener("error", (event) => {
    console.error("automerge SharedWorker error:", describeErrorEvent(event));
  });

  const startProbe = (reason: string) => {
    if (probe || disposed) return;
    lifecycleLog(
      "automerge SharedWorker %s; probing with a second connection",
      reason
    );
    const startedAt = Date.now();
    const p = new SharedWorker(automergeWorkerPath, {
      name: "patchwork-automerge",
      type: "module",
    });
    probe = p;
    p.port.start();
    p.port.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.type !== "hello") return;
      setTimeout(() => {
        if (disposed || probe !== p) return;
        closeProbe();
        // The suspect spoke while the probe ran: it was merely busy, and
        // everything queued on it has been delivered.
        if (lastHeardAt >= startedAt) return;
        void recoverAutomergeWorker(
          `port unresponsive on a live worker (${reason}; probe confirmed)`,
          worker
        );
      }, PROBE_GRACE_MS);
    });
    // No hello on the probe means the instance is loading or busy. The probe
    // waits indefinitely rather than tearing anything down on a timer.
  };

  const heartbeat = setInterval(() => {
    try {
      worker.port.postMessage({ type: "ping", id: ++seq });
    } catch (error) {
      // Without this a failed send is indistinguishable from a dead worker.
      if (!warnedSendFailed) {
        warnedSendFailed = true;
        console.error("automerge SharedWorker ping send threw", error);
      }
    }

    const neverHeard = instanceId === undefined;
    const silentMs = Date.now() - lastHeardAt;
    const timeoutMs = neverHeard
      ? FIRST_CONTACT_TIMEOUT_MS
      : HEARTBEAT_TIMEOUT_MS;
    if (silentMs <= timeoutMs) return;

    // First contact probes regardless of visibility: SharedWorkers don't
    // suspend with the tab, and the probe destroys nothing. Post-contact
    // silence defers to visibility, since a hidden page's throttling can fake
    // it.
    const visible =
      typeof document === "undefined" || document.visibilityState === "visible";
    if (!neverHeard && !visible) return;

    const seconds = Math.round(silentMs / 1000);
    const reason = neverHeard
      ? `no hello ~${seconds}s after connecting`
      : `no pong for ~${seconds}s`;
    if (!warnedUnresponsive) {
      warnedUnresponsive = true;
      lifecycleLog("automerge SharedWorker %s (tab visible)", reason);
    }
    startProbe(reason);
  }, HEARTBEAT_MS);

  return () => {
    disposed = true;
    clearInterval(heartbeat);
    closeProbe();
  };
}

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
  const worker = getAutomergeWorker();
  let listeners = syncStateListeners.get(documentId);
  if (!listeners) {
    syncStateListeners.set(documentId, (listeners = new Set()));
    worker.port.postMessage({ type: "sync-sub", documentId });
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
    // Unsubscribe from whichever instance is current: recovery replays
    // subscriptions onto a new worker, so it may not be the one captured above.
    automergeWorker?.port.postMessage({ type: "sync-unsub", documentId });
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

  const worker = getAutomergeWorker();
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
    worker.port.postMessage({ type: "connect-classic-sync", server: url }, [
      port2,
    ]);
  });
}

function sendRepoPort(id: number): MessagePort {
  const { port1, port2 } = new MessageChannel();
  getAutomergeWorker().port.postMessage({ type: "port", id }, [port2]);
  return port1;
}

/**
 * Wait for the worker to confirm its repo is constructed. The MessageChannel
 * adapter's whenReady() force-resolves after 100ms regardless of the other
 * end's state, so it can't serve as a readiness signal on first boot, when the
 * worker still has to fetch wasm and build its repo.
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
        reject(new Error(`automerge worker init failed: ${event.data.error}`));
      }
    };
    control.addEventListener("message", listener);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("automerge worker port-ready timeout"));
    }, 30_000);
  });
}

/** Open a repo sync port to the automerge worker, once it says it is ready. */
export async function openRepoPort(): Promise<MessagePort> {
  const id = ++nextRepoChannelId;
  const ready = awaitPortReady(getAutomergeWorker().port, id);
  const port = sendRepoPort(id);
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
  return port;
}

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

  // Start the automerge worker now so it boots wasm and its repo while the
  // service worker installs.
  const shared = getAutomergeWorker();

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
    openPort: openRepoPort,
    // The automerge worker died and was replaced, so anything held against the
    // old one — a repo port, a network adapter — is stranded. Ports opened from
    // here on reach the new instance, which boots with cold state.
    onRecreated(listener: () => void) {
      workerRecreatedListeners.add(listener);
      return () => {
        workerRecreatedListeners.delete(listener);
      };
    },
  };
}

(window as any).bumpServiceWorkerCache = bumpServiceWorkerCache;
