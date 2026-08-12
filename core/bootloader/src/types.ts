/**
 * The BroadcastChannel the service worker and the automerge shared worker
 * use to hand requests off to each other. Broadcast (rather than a
 * MessagePort handed from one to the other) so the two never need to be
 * reintroduced when either of them restarts — and so tabs can listen in.
 */
export const HANDOFF_CHANNEL = "@patchwork/handoff";

/**
 * BroadcastChannel on which the automerge shared worker announces remote
 * heads it learns about from the sync server. Any tab can listen to stay
 * informed of sync progress without repo-to-repo gossiping.
 */
export const SYNCSTATE_CHANNEL = "@patchwork/syncstate";

/**
 * Worker → tabs: the worker's Subduction link to the sync server flipped.
 * `serverPeerIds` are the directly-connected sync-server peer ids (their
 * verifying keys), so a tab can tell which peer rows are *the server* and
 * judge "synced" against them specifically.
 */
export interface SyncStateConnectionMessage {
  type: "connection";
  connected: boolean;
  serverPeerIds: string[];
}

/**
 * Worker → tabs: the shared worker's own Subduction identity, so a tab can
 * tell which peer rows are "us". `peerId` is `signer.peerId().toString()` (the
 * value that shows up as a peer id); `verifyingKey` is its hex Ed25519 key.
 */
export interface SyncStateWhoAmIMessage {
  type: "whoami";
  peerId: string;
  verifyingKey: string;
}

// What the worker broadcasts on SYNCSTATE_CHANNEL: only the *global* signals
// now. Per-document heads are addressed to subscribers over the control port
// instead (see SyncStateDocMessage) rather than fanned out to every tab.
export type SyncStateBroadcast =
  | SyncStateConnectionMessage
  | SyncStateWhoAmIMessage;

/**
 * Tab → worker: please replay the current global sync signals (whoami +
 * connection) so a freshly-opened tab can orient immediately. Per-document
 * heads are no longer replayed here — a tab subscribes to the specific docs it
 * cares about over its control port instead (see {@link SyncSubscribeMessage}).
 */
export interface SyncStateRequestMessage {
  type: "request";
  /** @deprecated ignored — per-doc state is delivered via sync-sub now. */
  documentId?: string;
}

// ── Per-tab sync-state subscription (over the SharedWorker control port) ──
//
// The broadcast SyncState* messages above are global (connection/whoami).
// Per-document heads, by contrast, are addressed: a tab subscribes its control
// port to just the documents it cares about and the worker pushes only those
// docs' heads back down that port. The worker drops a port's whole
// subscription set automatically when the port closes (the tab went away), so
// there's no reference counting or heartbeat to leak.

/** Tab → worker: start pushing me this document's heads (replays current state). */
export interface SyncSubscribeMessage {
  type: "sync-sub";
  documentId: string;
}

/** Tab → worker: stop pushing me this document's heads. */
export interface SyncUnsubscribeMessage {
  type: "sync-unsub";
  documentId: string;
}

/**
 * Worker → tab (control port): a peer's heads for a subscribed document — the
 * worker's own (keyed by its peerId) or a Subduction peer's (keyed by its
 * verifying-key storageId). Same payload as the old broadcast remote-heads
 * message, but delivered only to the tabs that asked for this document.
 */
export interface SyncStateDocMessage {
  type: "sync-state";
  documentId: string;
  storageId: string;
  heads: string[];
  timestamp: number;
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
  | HandoffCachedMessage
  | HandoffResponseMessage
  | HandoffAbortMessage;

/**
 * Automerge worker → world: broadcast once on startup so the service worker
 * can re-send any handoff requests that raced the worker's boot.
 */
export interface HandoffOnlineMessage {
  type: "online";
}

export type SetupServiceWorkerOptions = {
  /**
   * The public path to the service worker file.
   * Defaults to `/service-worker.js`
   */
  path?: string;
  /**
   * The public path to the automerge shared worker file.
   * Defaults to `/automerge-worker.js`
   */
  workerPath?: string;
};

export type SetupServiceWorkerResult = {
  shared?: SharedWorker;
  kill?: () => void;
  /** Open a classic Automerge sync WebSocket from the automerge worker. */
  connectClassicSync: (server?: string) => Promise<void>;
  /** Open a repo sync port to the automerge worker, once it says it is ready. */
  openPort: () => Promise<MessagePort>;
  /**
   * Watch for the automerge worker dying and being replaced. Ports held against
   * the old instance are stranded; open a fresh one.
   */
  onRecreated: (listener: () => void) => () => void;
  /**
   * Watch one document's sync heads (this tab's own and each Subduction peer's,
   * as the worker learns them). Calls `listener` on every update for that doc,
   * replaying the current state on subscribe. Returns an unsubscribe function;
   * the worker stops pushing the doc once the last local watcher drops it (and
   * automatically if this tab goes away).
   */
  subscribeSyncState: (
    documentId: string,
    listener: (update: SyncStateDocMessage) => void
  ) => () => void;
};
