/// <reference types="service-worker-types" />

import {
  HANDOFF_CHANNEL,
  type HandoffReplyMessage,
  type HandoffRequestMessage,
} from "./types.js";

const DEFAULT_CACHE_NAME = "patchwork";

let cachename = DEFAULT_CACHE_NAME;
let debugging = false;

// 0 is an opaque cross-origin response, which is cacheable and replays to the
// same no-cors consumer. these are big, so unfortunate.
const CACHEABLE_STATUSES = [0, 200, 203, 204];

// The automerge worker times its own resolution out after 30s and replies with
// an error, so this only fires when nobody is listening at all.
const HANDOFF_TIMEOUT_MS = 35_000;

function log(...args: any[]) {
  if (debugging) console.log("[service-worker]", ...args);
}

// A service worker has no localStorage and so can't read the debug config: it
// always emits these and forwards them to the tab, which does the filtering.
async function postToClients(message: unknown) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) client.postMessage(message);
}

function lifecycle(level: "info" | "warn", text: string) {
  const msg = `${new Date().toISOString()} ${text}`;
  console[level](msg);
  postToClients({ type: "sw-lifecycle", level, msg });
}

lifecycle("info", `booted (scope ${self.registration?.scope ?? "?"})`);

self.addEventListener("error", (event) => {
  const e = event as ErrorEvent;
  lifecycle(
    "warn",
    `uncaught error: ${e.message}` +
      (e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "")
  );
});

self.addEventListener("unhandledrejection", (event) => {
  const reason = (event as PromiseRejectionEvent).reason;
  lifecycle(
    "warn",
    `unhandled rejection: ${
      reason instanceof Error ? reason.stack || reason.message : String(reason)
    }`
  );
});

// ── Lifecycle ──────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  lifecycle("info", "install (skipWaiting)");
  // waitUntil keeps the worker alive until skipWaiting resolves, so a freshly
  // installed worker reliably jumps the waiting queue instead of stalling until
  // every old tab closes.
  (event as ExtendableEvent).waitUntil(self.skipWaiting());
});

async function clearOtherCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name !== cachename)
      .map((name) => caches.delete(name))
  );
}

self.addEventListener("activate", (event) => {
  lifecycle("info", "activate (claiming clients)");
  (event as ExtendableEvent).waitUntil(
    (async () => {
      await clearOtherCaches();
      await self.clients.claim();
      // Pre-cache the pages of already-open clients so they survive going
      // offline before the next navigation.
      const clients = await self.clients.matchAll({ type: "window" });
      const cache = await caches.open(cachename);
      await Promise.all(
        clients.map(async (client) => {
          try {
            if (await cache.match(client.url)) return;
            const response = await fetch(client.url);
            if (CACHEABLE_STATUSES.includes(response.status)) {
              await cachePage(cache, client.url, response);
            }
          } catch {
            // Network may be unavailable during activation.
          }
        })
      );
    })()
  );
});

self.addEventListener("message", async (event) => {
  const data = event.data;

  if (data?.type === "debug") {
    debugging = data.debug;
    log("serviceworker debugging enabled");
    return;
  }

  if (data?.type !== "cachename" || cachename === data.cachename) return;

  console.info(`moving from cache ${cachename} to ${data.cachename}`);
  const previous = cachename;
  // Switch before copying: fetches landing mid-copy must write into the new
  // cache, or their entries get deleted along with the old one below.
  cachename = data.cachename;
  if (previous === DEFAULT_CACHE_NAME) {
    const from = await caches.open(previous);
    const to = await caches.open(cachename);
    await Promise.all(
      (await from.keys()).map(async (request) => {
        const response = await from.match(request);
        if (response) await to.put(request, response);
      })
    );
  }
  await clearOtherCaches();
});

const handoffChannel = new BroadcastChannel(HANDOFF_CHANNEL);

type PendingHandoff = {
  message: HandoffRequestMessage;
  resolvers: PromiseWithResolvers<HandoffReplyMessage>;
};

const pendingHandoffs = new Map<string, PendingHandoff>();

handoffChannel.addEventListener("message", (event) => {
  const data = event.data;

  if (data?.type === "cached" || data?.type === "response") {
    const pending = pendingHandoffs.get(data.id);
    if (!pending) return log(`no pending handoff for id ${data.id}`);
    pending.resolvers.resolve(data as HandoffReplyMessage);
    return;
  }

  if (data?.type !== "online") return;
  // The automerge worker (re)started — re-broadcast anything still in flight so
  // requests that raced its boot aren't stranded.
  const stranded = [...pendingHandoffs.values()];
  if (stranded.length === 0) return;
  lifecycle(
    "info",
    `automerge worker (re)started; re-broadcasting ${stranded.length} in-flight asset handoff(s)`
  );
  for (const { message } of stranded) handoffChannel.postMessage(message);
});

/** Signals that respondWith should reject; see {@link HandoffAbortMessage}. */
class HandoffAborted extends Error {}

async function handoff(
  request: Request,
  handoffURL: URL
): Promise<HandoffReplyMessage> {
  const id = crypto.randomUUID();
  const resolvers = Promise.withResolvers<HandoffReplyMessage>();
  const message: HandoffRequestMessage = {
    id,
    type: "request",
    cachename,
    request: {
      url: request.url,
      handoffURL: handoffURL.href,
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
      destination: request.destination,
      referrer: request.referrer,
    },
  };

  pendingHandoffs.set(id, { message, resolvers });
  log(`broadcasting handoff request for cache ${cachename}`, message);
  handoffChannel.postMessage(message);

  const timeout = setTimeout(() => {
    lifecycle(
      "warn",
      `asset handoff ${id} stranded: no reply from the automerge worker after ${HANDOFF_TIMEOUT_MS}ms (${handoffURL.href})`
    );
    resolvers.reject(
      new Error(
        `no reply from the automerge worker after ${HANDOFF_TIMEOUT_MS}ms`
      )
    );
  }, HANDOFF_TIMEOUT_MS);

  return resolvers.promise.finally(() => {
    clearTimeout(timeout);
    pendingHandoffs.delete(id);
  });
}

// ── Caching ────────────────────────────────────────────────────────────

/** A page is cached under its own url plus /index.html and / on this origin. */
function pageCacheKeys(request: Request | string): Request[] {
  const original = typeof request === "string" ? new Request(request) : request;
  const url = new URL(original.url);
  if (url.origin !== self.location.origin) return [original];

  return [
    original,
    ...["/index.html", "/"].map((pathname) => {
      const variant = new URL(url.href);
      variant.pathname = pathname;
      variant.search = "";
      variant.hash = "";
      return new Request(variant.href);
    }),
  ];
}

async function cachePage(
  cache: Cache,
  request: Request | string,
  response: Response
) {
  const keys = pageCacheKeys(request);
  await Promise.all(
    keys.map((key, i) =>
      cache.put(key, i === keys.length - 1 ? response : response.clone())
    )
  );
}

// cache.put only resolves once the whole body has been consumed and persisted,
// so awaiting it before returning would turn time-to-first-byte into
// time-to-last-byte-plus-disk for every proxied asset. waitUntil keeps the
// worker alive for the write.
function cacheInBackground(
  fetchEvent: FetchEvent,
  cache: Cache,
  request: Request,
  response: Response
) {
  const isPage =
    request.mode === "navigate" || request.destination === "document";
  fetchEvent.waitUntil(
    (isPage
      ? cachePage(cache, request, response)
      : cache.put(request, response)
    ).catch((error) => {
      // Always loud: a QuotaExceededError here is the first sign the origin is
      // under storage pressure.
      console.warn(`error caching ${request.url} in ${cachename}`, error);
    })
  );
}

/** A same-origin path that is itself an encoded URL, e.g. /automerge%3Aabc/x. */
function specialURLFor(request: Request): URL | undefined {
  const url = new URL(request.url);
  if (
    url.hostname !== self.location.hostname ||
    url.port !== self.location.port ||
    url.protocol !== self.location.protocol
  ) {
    return undefined;
  }
  try {
    return new URL(decodeURIComponent(url.pathname.slice(1)));
  } catch {
    return undefined;
  }
}

async function serveHandoff(
  fetchEvent: FetchEvent,
  cache: Cache,
  handoffURL: URL,
  cached: Response | undefined
): Promise<Response> {
  if (cached) {
    log(`serving ${handoffURL} from cache ${cachename}`);
    return cached;
  }

  log(`handing ${handoffURL} off to the automerge worker`);
  const replyPromise = handoff(fetchEvent.request, handoffURL);
  fetchEvent.waitUntil(replyPromise.catch(() => {}));
  const reply = await replyPromise;

  if (reply.type === "abort") {
    // Rejecting respondWith gives the caller a network error rather than a
    // response it can memoize.
    log(`aborting ${handoffURL}: ${reply.reason}`);
    throw new HandoffAborted(reply.reason);
  }

  if (reply.type === "response") {
    log(`serving handed-off response for ${handoffURL}`, reply);
    return new Response(reply.response.body ?? null, {
      status: reply.response.status ?? 200,
      headers: reply.response.headers,
    });
  }

  const stored = await cache.match(fetchEvent.request);
  if (!stored) {
    return new Response(
      `the automerge worker reported ${handoffURL} cached, but it has no match in ${cachename}`,
      { status: 555 }
    );
  }
  log(`serving ${handoffURL} from cache ${cachename} after handoff`);
  return stored;
}

async function servePassthrough(
  fetchEvent: FetchEvent,
  cache: Cache,
  cached: Response | undefined
): Promise<Response> {
  const request = fetchEvent.request;
  // fetch() rejects on network error rather than resolving, so keep the error
  // to surface in the 503 body below.
  const result = await fetch(request).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))
  );

  if (result instanceof Response) {
    if (
      CACHEABLE_STATUSES.includes(result.status) &&
      /^https?:/.test(request.url)
    ) {
      const etag = result.headers.get("etag");
      if (!etag || etag !== cached?.headers.get("etag")) {
        cacheInBackground(fetchEvent, cache, request, result.clone());
      }
    } else {
      log(`not caching status ${result.status} for ${request.url}`);
    }
    return result;
  }

  if (cached) return cached;
  return new Response(
    `couldnt fetch ${request.url} and no stale copy in ${cachename}\n\n${
      result.stack ?? result.message
    }`,
    { status: 503, headers: { "content-type": "text/plain" } }
  );
}

async function respond(
  fetchEvent: FetchEvent,
  handoffURL: URL | undefined
): Promise<Response> {
  const cache = await caches.open(cachename);
  // A cors request (e.g. the wasm `<link rel=preload crossorigin>`) can miss
  // an entry that a url-keyed lookup finds, so fall back to the bare url —
  // offline boot depends on this hitting.
  const cached =
    (await cache.match(fetchEvent.request)) ??
    (await cache.match(fetchEvent.request.url));

  try {
    return handoffURL
      ? await serveHandoff(fetchEvent, cache, handoffURL, cached)
      : await servePassthrough(fetchEvent, cache, cached);
  } catch (error) {
    // Deliberate: fail the request as a network error, with no response.
    if (error instanceof HandoffAborted) throw error;

    console.error(
      `service worker error resolving ${fetchEvent.request.url}` +
        (handoffURL ? ` (for: ${handoffURL})` : ""),
      error
    );
    if (cached) return cached;
    return new Response(
      error instanceof Error
        ? `${error.message}\n\n${error.stack}`
        : String(error),
      { status: 556, headers: { "content-type": "text/plain" } }
    );
  }
}

self.addEventListener("fetch", (fetchEvent: FetchEvent) => {
  const request = fetchEvent.request;
  log("fetch event", request.url);
  if (request.method !== "GET") return;
  fetchEvent.respondWith(respond(fetchEvent, specialURLFor(request)));
});
