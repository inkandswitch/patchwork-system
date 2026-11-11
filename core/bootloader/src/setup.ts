import type {
  NewBuildInfo,
  SetupServiceWorkerOptions,
  SetupServiceWorkerResult,
} from "./types.js";
import { buildId, isNewerBuild } from "./build-id.js";
import { promptForNewBuild } from "./new-build-prompt.js";
import debug from "debug";
import type { PortBackend } from "./hub/port-backend.js";
import { handleResolveRequest } from "./tab-resolver.js";
import {
  forwardWorkerConsole,
  lifecycleLog,
  sharedWorkerHandle,
} from "./shared-worker-lifecycle.js";

export { lifecycleLog };
export { resolveHandoffsWith } from "./tab-resolver.js";
export { PortBackend } from "./hub/port-backend.js";
export type { ArkVersion } from "./hub/hub.js";

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
// it always emits lifecycle markers and forwards them here to be filtered. It
// also asks this tab to resolve requests (see tab-resolver.ts), which needs a
// listener from the start so a tab without a Repo yet can say so.
let logForwardingInstalled = false;
function installServiceWorkerLogForwarding(): void {
  if (logForwardingInstalled) return;
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  logForwardingInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (handleResolveRequest(event)) return;
    if (event.data?.type === "automerge-worker-missing") {
      automergeProtocolHandlerWorker.revive();
      return;
    }
    if (event.data?.type !== "sw-lifecycle") return;
    lifecycleLog("[service-worker] %s", event.data.msg);
  });
  // A listener added with addEventListener only hears the service worker once
  // the document has loaded; a request to resolve can't wait for that.
  navigator.serviceWorker.startMessages();
}

// After a deploy, open tabs are on the old build. The default response is to
// say so and offer a reload, rather than reload out from under someone
// mid-edit; an old page sharing IndexedDB with the new automerge worker is
// still where storage-format changes bite, so it shouldn't stay that way long.

let onNewBuild: ((info: NewBuildInfo) => void) | undefined;

function newBuild(info: NewBuildInfo): void {
  lifecycleLog("new build detected via %s", info.source);
  (onNewBuild ?? promptForNewBuild)(info);
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

// A SharedWorker holding the origin's one node (see hub/hub.ts): every tab's
// Repo stores and syncs through it, and its own Repo resolves `automerge:`
// URLs for the service worker when no tab can. Only a page can start a
// SharedWorker, so each tab keeps it alive and starts a new one when it goes: when it says it's closing, when its
// port closes, or when the Web Lock it holds for its lifetime is released (see
// AUTOMERGE_WORKER_LOCK).

let automergeProtocolHandlerWorkerPath =
  "/automerge-protocol-handler-worker.js";

let automergeWorkerSpawned = false;

const automergeProtocolHandlerWorker = sharedWorkerHandle(
  "patchwork-automerge-protocol-handler",
  () => automergeProtocolHandlerWorkerPath,
  {
    debugging: workerDebugging,
    onMessage(event) {
      forwardWorkerConsole("automerge-protocol-handler-worker", event.data);
    },
    // A replacement knows none of the tabs the last one served.
    onSpawn() {
      if (automergeWorkerSpawned) {
        queueMicrotask(() => hubClients.forEach(hand));
      }
      automergeWorkerSpawned = true;
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

/**
 * Connect `backend` (this tab's Repo's) to the automerge worker, and again to
 * every worker that replaces it: each gets a port of its own, and the backend
 * carries on over the new one (see hub/port-backend.ts).
 */
export function connectToAutomergeWorker(backend: PortBackend): void {
  hubClients.add(backend);
  automergeProtocolHandlerWorker.get();
  hand(backend);
}

const hubClients = new Set<PortBackend>();

function hand(backend: PortBackend) {
  const { port1, port2 } = new MessageChannel();
  automergeProtocolHandlerWorker.post({ type: "hub", port: port2 }, [port2]);
  backend.attach(port1);
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

// How long the active worker gets to claim this page before it's reloaded.
const CLAIM_TIMEOUT_MS = 3_000;
// When this tab last reloaded to come under the worker, so a worker that never
// takes control fails boot instead of reloading the page forever.
const CONTROL_RELOAD_KEY = "patchwork:reloaded-for-service-worker";
const CONTROL_RELOAD_WINDOW_MS = 30_000;

/**
 * Bring this page under the service worker. A first install's worker claims
 * the page as it activates, but a hard reload loads the page past a worker
 * that's already active and won't activate again, so nothing would ever take
 * control. Ask it to claim the page; if it doesn't (a worker from a build that
 * doesn't know `claim`), reload once, normally, which it does control.
 */
async function takeControl(active: ServiceWorker | null): Promise<void> {
  const controlled = new Promise<boolean>((resolve) => {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => resolve(true),
      { once: true }
    );
    setTimeout(() => resolve(false), CLAIM_TIMEOUT_MS);
  });
  active?.postMessage({ type: "claim" });
  if ((await controlled) || navigator.serviceWorker.controller) return;

  const lastReload = Number(sessionStorage.getItem(CONTROL_RELOAD_KEY));
  if (Date.now() - lastReload < CONTROL_RELOAD_WINDOW_MS) {
    throw new Error(
      "the service worker didn't take control of this page, even after a reload"
    );
  }
  console.warn("service worker didn't claim this page; reloading once");
  sessionStorage.setItem(CONTROL_RELOAD_KEY, String(Date.now()));
  location.reload();
  // The reload replaces this page; nothing after it should run.
  await new Promise<never>(() => {});
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
  // install or a hard reload. The app needs the worker in control of generated
  // fetches before it boots.
  if (!navigator.serviceWorker.controller) await takeControl(active);

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

  return { shared };
}

(window as any).bumpServiceWorkerCache = bumpServiceWorkerCache;
(window as any).restartAutomergeProtocolHandlerWorker =
  restartAutomergeProtocolHandlerWorker;
