import type {
  NewBuildInfo,
  SetupServiceWorkerOptions,
  SetupServiceWorkerResult,
} from "./types.js";
import { buildId, isNewerBuild } from "./build-id.js";
import {
  readClassicSyncServer,
  DEFAULT_CLASSIC_SYNC_SERVER,
} from "./sync-config.js";
import debug from "debug";
import {
  forwardWorkerConsole,
  lifecycleLog,
  sharedWorkerHandle,
} from "./shared-worker-lifecycle.js";

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

// ── New builds ─────────────────────────────────────────────────────────
// After a deploy, open tabs are on the old build. The default response is to
// reload, because the alternative — an old page sharing IndexedDB with the
// new automerge worker — is where storage-format changes bite.

const RELOAD_THROTTLE_KEY = "patchworkNewBuildReloadedAt";
const RELOAD_THROTTLE_MS = 30_000;

let onNewBuild: ((info: NewBuildInfo) => void) | undefined;

function reloadForNewBuild(info: NewBuildInfo): void {
  // Something is wrong if we keep landing back here (an offline tab served a
  // stale page, say); don't let it turn into a reload loop.
  const last = Number(sessionStorage.getItem(RELOAD_THROTTLE_KEY));
  if (last && Date.now() - last < RELOAD_THROTTLE_MS) {
    console.warn("new build detected, but reloaded recently; staying put", info);
    return;
  }
  sessionStorage.setItem(RELOAD_THROTTLE_KEY, Date.now().toString());
  lifecycleLog("new build detected via %s, reloading", info.source);
  location.reload();
}

function newBuild(info: NewBuildInfo): void {
  (onNewBuild ?? reloadForNewBuild)(info);
}

/**
 * The build a service worker was compiled from, or undefined if it doesn't
 * say (one from before this existed) within a couple of seconds.
 */
function serviceWorkerBuild(sw: ServiceWorker): Promise<number | undefined> {
  const { port1, port2 } = new MessageChannel();
  return new Promise<number | undefined>((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), 2_000);
    port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(
        typeof event.data?.build === "number" ? event.data.build : undefined
      );
    };
    sw.postMessage({ type: "build" }, [port2]);
  }).finally(() => port1.close());
}

// ── The automerge worker ───────────────────────────────────────────────
// A SharedWorker holding the Repo that resolves `automerge:` URLs for the
// service worker. Tabs don't sync through it — each tab is its own node — but
// each tab keeps it alive and heartbeats it, so it's here rather than in the
// service worker, which can't own one.

let automergeProtocolHandlerWorkerPath =
  "/automerge-protocol-handler-worker.js";

const automergeProtocolHandlerWorker = sharedWorkerHandle(
  "patchwork-automerge-protocol-handler",
  () => automergeProtocolHandlerWorkerPath,
  {
    debugging: workerDebugging,
    onMessage(event) {
      forwardWorkerConsole("automerge-protocol-handler-worker", event.data);
    },
    onRestarting(message) {
      // The worker restarts because a newer tab connected. If that build is
      // newer than ours too, we're the stale one.
      if (isNewerBuild(message.build)) {
        newBuild({
          source: "shared-worker",
          build: message.build,
          current: buildId,
        });
      }
    },
  }
);

export function getAutomergeProtocolHandlerWorker(): SharedWorker {
  return automergeProtocolHandlerWorker.get();
}

/** Dev escape hatch: make the shared worker close so the next use respawns it. */
export function restartAutomergeProtocolHandlerWorker(
  reason = "restartAutomergeProtocolHandlerWorker() called"
): void {
  automergeProtocolHandlerWorker.restart(reason);
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
    automergeProtocolHandlerWorker.post(
      { type: "connect-classic-sync", server: url },
      [port2]
    );
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
  onNewBuild = options?.onNewBuild;

  // Cache growth can otherwise trip origin-wide eviction, which would take the
  // Automerge IndexedDB — the user's documents — with it. Chrome/Safari decide
  // silently from site engagement; Firefox may prompt. Denial just means
  // default eviction.
  void navigator.storage?.persist?.().catch(() => {});

  if (options?.workerPath)
    automergeProtocolHandlerWorkerPath = options.workerPath;

  // Start it now so it boots wasm while the service worker installs.
  const shared = automergeProtocolHandlerWorker.get();

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
  // whenever a new one takes control. A new one taking control is also how a
  // deploy shows up: the service worker skipWaiting()s and claims every open
  // tab. But it also claims the tab whose load installed it, which is already
  // on the new build, so only a worker from a newer build than ours counts.
  navigator.serviceWorker.addEventListener("controllerchange", async () => {
    const controller = navigator.serviceWorker.controller;
    configureServiceWorker(controller);
    if (!controller) return;
    const build = await serviceWorkerBuild(controller);
    if (isNewerBuild(build)) {
      newBuild({ source: "service-worker", build, current: buildId });
    }
  });

  console.log(
    "service worker alive, loading %c patchwork system ",
    "background: #fcf2f0; color: #333; border: 2px solid; border-radius: 4px"
  );

  return { shared, connectClassicSync };
}

(window as any).bumpServiceWorkerCache = bumpServiceWorkerCache;
(window as any).restartAutomergeProtocolHandlerWorker =
  restartAutomergeProtocolHandlerWorker;
