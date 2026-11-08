import type {
  NewBuildInfo,
  SetupServiceWorkerOptions,
  SetupServiceWorkerResult,
} from "./types.js";
import { buildId, isNewerBuild } from "./build-id.js";
import { promptForNewBuild } from "./new-build-prompt.js";
import debug from "debug";
import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import type { PublicReaderStatus } from "./public-pair.js";
import { handleResolveRequest } from "./tab-resolver.js";
import {
  forwardWorkerConsole,
  lifecycleLog,
  sharedWorkerHandle,
} from "./shared-worker-lifecycle.js";

export { lifecycleLog };
export { resolveHandoffsWith } from "./tab-resolver.js";
export { connectClassicSync } from "./classic-sync.js";

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

// A SharedWorker holding a Repo that resolves `automerge:` URLs for the
// service worker when no tab can. Tabs don't sync through it — each tab is its
// own node — but only a page can start a SharedWorker, so each tab keeps it
// alive and starts a new one when it goes: when it says it's closing, when its
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
    // A replacement knows nothing of the public reader.
    onSpawn() {
      if (automergeWorkerSpawned && publicReaderEnabled) {
        queueMicrotask(introduceResolver);
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

// A SharedWorker reading documents made public to Patchwork (see
// public-reader.ts), which this tab's Repo and the resolver's connect to.
// Only a page can start a SharedWorker, and one can't start another, so the
// tabs keep it alive and introduce the resolver to it, again whenever either
// is replaced.

declare const __SYNC_SERVER__: { keyhive?: boolean; ark?: "0.6" | "0.8" };

/** Only ARK 0.8's keyhive has a public pair. */
const publicReaderEnabled =
  typeof __SYNC_SERVER__ !== "undefined" &&
  !!__SYNC_SERVER__.keyhive &&
  __SYNC_SERVER__.ark !== "0.6";

/** The public reader's latest status, and who wants to hear the next. */
let publicReaderStatus: PublicReaderStatus | undefined;
const publicReaderStatusListeners = new Set<
  (status: PublicReaderStatus) => void
>();

/**
 * Hear how far the public reader has got (the latest straight away, if
 * there's been one), for a loading screen. Returns a function that stops.
 */
export function onPublicReaderStatus(
  listener: (status: PublicReaderStatus) => void
): () => void {
  publicReaderStatusListeners.add(listener);
  if (publicReaderStatus) listener(publicReaderStatus);
  return () => publicReaderStatusListeners.delete(listener);
}

export type { PublicReaderStatus };

/** What connects a Repo to the public reader, run again for each new one. */
const publicReaderClients = new Set<() => void>();
let publicReaderSpawned = false;

const publicReaderWorker = sharedWorkerHandle(
  "patchwork-public-reader",
  () => "/public-reader-worker.js",
  {
    debugging: workerDebugging,
    onMessage(event) {
      if (event.data?.type === "status") {
        publicReaderStatus = event.data.status as PublicReaderStatus;
        for (const listener of publicReaderStatusListeners) {
          listener(publicReaderStatus);
        }
        return;
      }
      forwardWorkerConsole("public-reader-worker", event.data);
    },
    // A new instance knows none of the Repos the last one served.
    onSpawn(worker) {
      worker.port.postMessage({
        type: "debug-namespaces",
        namespaces: localStorage.getItem("debug") ?? "",
      });
      if (publicReaderSpawned) {
        queueMicrotask(() =>
          publicReaderClients.forEach((connect) => connect())
        );
      }
      publicReaderSpawned = true;
    },
  }
);

function addPublicReaderClient(connect: () => void) {
  publicReaderClients.add(connect);
  publicReaderWorker.get();
  connect();
}

/** A port the public reader answers on, as a new client. */
function publicReaderPort(): MessagePort {
  const { port1, port2 } = new MessageChannel();
  publicReaderWorker.post({ type: "client", port: port2 }, [port2]);
  return port1;
}

function introduceResolver() {
  const port = publicReaderPort();
  automergeProtocolHandlerWorker.post({ type: "public-reader", port }, [port]);
}

/**
 * Whether patchwork's public reader can read `url` (whether it's public), as
 * seen from `repo`'s connection to it. False when there's no reader.
 */
export async function publicReaderCanRead(
  repo: Repo,
  url: AutomergeUrl
): Promise<boolean> {
  if (!publicReaderEnabled) return false;
  const { publicReaderCanRead: ask } = await import("./public-pair.js");
  return ask(repo, url);
}

/**
 * Give `repo` a peer that reads docs made public to Patchwork, in the public
 * reader's SharedWorker. Nothing waits on it: a find for a public doc is
 * answered once the reader has it.
 */
export function connectPublicReader(
  repo: Repo,
  hive: AutomergeRepoKeyhive
): void {
  if (!publicReaderEnabled) return;
  let hangUp: Promise<(() => void) | undefined> | undefined;
  addPublicReaderClient(() => {
    const control = publicReaderPort();
    const previous = hangUp;
    hangUp = (async () => {
      (await previous)?.();
      try {
        const { connectToPublicReader } = await import("./public-pair.js");
        return await connectToPublicReader({ repo, hive, control });
      } catch (error) {
        console.error("couldn't connect to the public reader", error);
        control.close();
        return undefined;
      }
    })();
  });
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
  // And the public reader, which has keyhive to catch up on.
  if (publicReaderEnabled) addPublicReaderClient(introduceResolver);

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
