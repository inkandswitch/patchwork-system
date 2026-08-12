// The Repo that resolves `automerge:` URLs for the service worker, in a
// SharedWorker: one instance serves every tab and lives as long as any tab
// does.
//
// It holds no storage of its own — it is a storageless node hanging off the
// subduction worker, and resolving requests is its whole job. When the service
// worker misses the cache for a request that looks like a URL encoded URL, it
// broadcasts a HandoffRequestMessage on HANDOFF_CHANNEL; we resolve the
// automerge URL, write the response into the service worker's cache (keyed by
// a Request reconstructed to match the one it's holding), and reply on the same
// channel.
import { initializeWasm, hasHeads } from "@automerge/automerge/slim";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
import { makePortProvider } from "@automerge/automerge-repo/worker-port";

import {
  Repo,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type PeerId,
} from "@automerge/automerge-repo/slim";
import { resolvePath } from "@inkandswitch/patchwork-filesystem";

import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket";

import { DEFAULT_CLASSIC_SYNC_SERVER } from "./sync-config.js";
import { WorkerSubductionEndpoint } from "./worker-link.js";
import { startWorkerControl, postToPort } from "./worker-control.js";
import {
  HANDOFF_CHANNEL,
  type HandoffCachedMessage,
  type HandoffOnlineMessage,
  type HandoffAbortMessage,
  type HandoffRequestMessage,
  type HandoffResponseMessage,
} from "./types.js";

const RESOLVE_TIMEOUT_MS = 30_000;

const CACHEABLE_STATUSES = [200, 203, 204];

let link: WorkerSubductionEndpoint | undefined;

const control = startWorkerControl("automerge-worker", {
  // The tab side runs donatePort; the messages are channel-tagged so they
  // coexist with the control protocol.
  onConnect: (port) => linkPortProvider.attachClient(port),
  onMessage: handleControlMessage,
});
const log = control.log;

// A SharedWorker can neither spawn nor connect to another SharedWorker, so a
// tab brokers this worker's link to the subduction worker: it asks for a port
// and donates one.
const linkPortProvider = makePortProvider({ target: "subduction-link" });

// ── The repo ───────────────────────────────────────────────────────────

let repoPromise: Promise<Repo> | null = null;

function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = buildRepo();
    // Don't cache a rejection (e.g. the wasm fetch failed): clear the slot so
    // the next caller retries from scratch.
    repoPromise.catch(() => {
      repoPromise = null;
    });
  }
  return repoPromise;
}

async function buildRepo(): Promise<Repo> {
  log("fetching wasm");
  const [automergeWasm, subductionWasm] = await Promise.all([
    fetch("/automerge.wasm").then((r) => r.arrayBuffer()),
    fetch("/subduction.wasm").then((r) => r.arrayBuffer()),
  ]);
  initSubductionSync(new Uint8Array(subductionWasm));
  await initializeWasm(new Uint8Array(automergeWasm));
  log("wasm initialized");

  const repo = new Repo({
    signer: new MemorySigner(),
    peerId: `resolver-${Math.random().toString(36).slice(2)}` as PeerId,
    subductionWebsocketEndpoints: [
      (link = new WorkerSubductionEndpoint(
        () => linkPortProvider.source() as Promise<MessagePort>
      )),
    ],
  });

  (self as never as { repo: Repo }).repo = repo;
  return repo;
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
  // The subduction worker died and was replaced: the donated port ends in a
  // worker that no longer exists, so drop it and ask for another.
  if (data?.type === "link-lost") {
    linkPortProvider.invalidate();
    link?.reset();
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
  const [maybeAutomergeUrl, ...path] = automergeURL.href.split("/");

  if (!isValidAutomergeUrl(maybeAutomergeUrl)) {
    return new Response("invalid automerge url", { status: 400 });
  }

  if (path.length && !path[path.length - 1]) path.pop();

  const { heads, hexHeads, documentId } = parseAutomergeUrl(maybeAutomergeUrl);

  // todo, maybe a bad idea? maybe we should throw instead of es-module-caching
  // the headless req
  if (!heads) {
    const folder = await repo.find(maybeAutomergeUrl, { signal });
    const url = stringifyAutomergeUrl({ documentId, heads: folder.heads() });
    const location = `/${encodeURIComponent(url)}${path.length ? `/${path.join("/")}` : ""}`;
    return Response.redirect(location, 307);
  }

  const baseHandle = await repo.find(stringifyAutomergeUrl({ documentId }), {
    signal,
  });
  if (!(await waitForHeads(baseHandle, hexHeads ?? [], signal))) {
    throw new AbortHandoff(
      `heads not found for ${maybeAutomergeUrl} within ${RESOLVE_TIMEOUT_MS}ms`
    );
  }

  const resolved = await resolvePath(
    repo,
    baseHandle.view(heads),
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

async function handleHandoffRequest(message: HandoffRequestMessage) {
  const { id, cachename, request } = message;

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

  let response: Response;
  try {
    log(`resolving handoff ${id} for ${handoff}`);
    const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    response = await Promise.race([
      resolveAutomergeUrl(handoff, signal),
      impatience(RESOLVE_TIMEOUT_MS),
    ]);
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
    if (!CACHEABLE_STATUSES.includes(response.status)) {
      // Errors, redirects and the like go back inline for the service worker to
      // serve directly, so they aren't cached forever (still in esmodulecache,
      // cleared after a refresh)
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

handoffChannel.addEventListener("message", (event) => {
  if (event.data?.type === "request") {
    void handleHandoffRequest(event.data as HandoffRequestMessage);
  }
});

// Announce ourselves so the service worker can re-broadcast handoff requests
// sent while we were booting.
handoffChannel.postMessage({ type: "online" } satisfies HandoffOnlineMessage);
