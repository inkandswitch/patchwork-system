/**
 * The BroadcastChannel the service worker and the automerge shared worker
 * use to hand requests off to each other. Broadcast (rather than a
 * MessagePort handed from one to the other) so the two never need to be
 * reintroduced when either of them restarts — and so tabs can listen in.
 */
export const HANDOFF_CHANNEL = "@patchwork/handoff";

/**
 * The Web Lock the automerge worker holds for as long as it lives. The
 * browser releases it when the instance goes, however it goes, so a
 * replacement waits for it before starting (two never sync or resolve at
 * once), tabs waiting on it hear the worker die, and the service worker can
 * ask whether there's a worker at all.
 */
export const AUTOMERGE_WORKER_LOCK = "@patchwork/automerge-worker";

/**
 * The Cache Storage cache where a restarting automerge worker leaves what it
 * had loaded, for its replacement. Not the service worker's own cache, so it
 * has to survive the service worker clearing out every cache but its own.
 */
export const LOADED_CACHE = "patchwork-package-memory";

/**
 * Service worker → tabs: there's no automerge worker (nothing holds or is
 * waiting for {@link AUTOMERGE_WORKER_LOCK}), so a handoff would go unanswered.
 * Start one.
 */
export interface AutomergeWorkerMissingMessage {
  type: "automerge-worker-missing";
}

/**
 * The special URL to resolve, plus enough of the {@link Request} the service
 * worker is holding that the automerge worker can construct one that
 * `cache.match`es it.
 *
 * Stale workers on either side of the channel can outlive a deploy, so the
 * shape can only ever change additively: `url` must stay the http request
 * URL old automerge workers decode the special URL out of, and new meaning
 * goes in new fields old receivers ignore.
 */
export interface HandoffRequest {
  /**
   * The URL of the request the service worker is holding (the encoded
   * `https://…/automerge%3Aabc/…` form) — the cache key.
   */
  url: string;
  /** the decoded special URL, e.g. `automerge:abc/some/path` */
  handoffURL: string;
  /**
   * @deprecated A briefly-deployed shape put the special URL in `url` and
   * the cache key here. Only read, never sent.
   */
  cacheKey?: string;
  headers: Record<string, string>;
  method: string;
  destination: RequestDestination;
  referrer: string;
}

/**
 * Service worker → automerge worker: please resolve this request and put
 * the response in my cache.
 */
export interface HandoffRequestMessage {
  id: string;
  type: "request";
  /** the current name of the service worker cache */
  cachename: string;
  request: HandoffRequest;
}

/**
 * Automerge worker → service worker: the response is stored in the cache
 * under the request you're holding. Serve `cache.match`.
 */
export interface HandoffCachedMessage {
  id: string;
  type: "cached";
}

/**
 * An inline response for things that shouldn't be cached: errors, redirects
 * &c.
 */
export interface HandoffResponse {
  body?: string | Uint8Array<ArrayBuffer>;
  /** defaults to 200 */
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Automerge worker → service worker: don't cache anything, serve this
 * response directly.
 */
export interface HandoffResponseMessage {
  id: string;
  type: "response";
  response: HandoffResponse;
}

/**
 * Automerge worker → service worker: fail the request as a network error
 * rather than serving any response at all.
 *
 * "Heads haven't arrived yet" is not a 404 — the document may well exist, so
 * a status implying it doesn't is a lie any HTTP cache is entitled to store.
 * A network error is the honest answer and isn't storable as a response.
 *
 * This does *not* help with `import()`: the ES module map memoizes failed
 * fetches, network errors included, so a retry needs a distinct URL either
 * way (see `importModule` in patchwork-filesystem).
 */
export interface HandoffAbortMessage {
  id: string;
  type: "abort";
  reason: string;
}

export type HandoffReplyMessage =
  HandoffCachedMessage | HandoffResponseMessage | HandoffAbortMessage;

/**
 * Automerge worker → world: broadcast once on startup so the service worker
 * can re-send any handoff requests that raced the worker's boot.
 */
export interface HandoffOnlineMessage {
  type: "online";
}

/**
 * The BroadcastChannel tools ask the automerge worker on how much memory a
 * package's documents take to load. The worker is what loads them, to serve
 * the package's files, so it measures them where they'd be loaded anyway
 * rather than in the tab asking. A site whose worker doesn't listen never
 * answers.
 *
 * Like {@link HANDOFF_CHANNEL}, the shapes can only change additively.
 */
export const PACKAGE_MEMORY_CHANNEL = "@patchwork/package-memory";

/**
 * Tool → automerge worker: how much memory does the package at `url` take?
 *
 * By default the answer is the package's documents the worker has loaded to
 * serve its files since it started, each measured as it was loaded. That's
 * what the package actually costs, and answering loads nothing.
 *
 * With `walk`, the worker loads every document in the package to measure it,
 * fetching any it hasn't stored. That covers files nothing has asked for
 * (READMEs, lockfiles, images), but it's slow, and loading a document with
 * one huge change costs the worker that much memory: measuring can itself be
 * the most expensive thing the worker does.
 */
export interface PackageMemoryRequestMessage {
  id: string;
  type: "request";
  /** The package's root doc, at heads or without (for the latest). */
  url: string;
  walk?: boolean;
}

/**
 * One document in a package. What it costs automerge to load grows faster
 * than its ops: much faster for one big change than for the same ops spread
 * over many. A file's text written as a plain string in one change is an op
 * per character, all in that change; one of 585k characters took ~300 MB of
 * wasm memory to load, where as an `ImmutableString` it took none.
 */
export interface PackageMemoryDocument {
  url: string;
  /** Where in the package it is, `""` for the root. */
  path: string;
  ops: number;
  changes: number;
  /** The ops in its biggest single change. */
  largestChange: number;
  /** How a file doc's `content` is stored, and how long it is. */
  content?: {
    kind: "text" | "immutable" | "bytes";
    length: number;
  };
  /** Set if it couldn't be found, and the counts are 0. */
  error?: string;
}

/**
 * Automerge worker → tool: the request arrived and is queued behind any
 * others. Sent straight away, so a tool can tell a worker that can't measure
 * (it never hears this) from one that's still measuring.
 */
export interface PackageMemoryAcceptedMessage {
  id: string;
  type: "accepted";
}

/** Automerge worker → tool: the package's documents, root first. */
export interface PackageMemoryReplyMessage {
  id: string;
  type: "reply";
  documents: PackageMemoryDocument[];
  /** Set if the package couldn't be measured; `documents` has what was. */
  error?: string;
}

/**
 * Why a tab has decided a newer build of the site is live.
 *
 * - `service-worker`: a replacement service worker took control of this tab,
 *   which happens in every open tab shortly after a deploy.
 * - `shared-worker`: the automerge shared worker restarted because a tab from
 *   a newer build connected to it, and this tab is older than that build.
 */
export type NewBuildInfo = {
  source: "service-worker" | "shared-worker";
  /** The newer build, when known (the shared worker reports it). */
  build?: number;
  /** This tab's build, when it was built with the vite plugin. */
  current?: number;
};

export type SetupServiceWorkerOptions = {
  /**
   * The public path to the service worker file.
   * Defaults to `/service-worker.js`
   */
  path?: string;
  /**
   * The public path to the automerge shared worker file.
   * Defaults to `/automerge-protocol-handler-worker.js`
   */
  workerPath?: string;
  /**
   * What to do when a newer build of the site is live and this tab is stale.
   * The default pops up a small box in the corner saying there's an updated
   * patchwork system core, with a button to reload. Until then the page stays
   * on the old build, sharing IndexedDB with a newer automerge worker. Replace
   * it to handle that some other way, say `() => location.reload()`.
   */
  onNewBuild?: (info: NewBuildInfo) => void;
};

export type SetupServiceWorkerResult = {
  shared?: SharedWorker;
  kill?: () => void;
  /** Open a classic Automerge sync WebSocket from the automerge worker. */
  connectClassicSync: (server?: string) => Promise<void>;
};
