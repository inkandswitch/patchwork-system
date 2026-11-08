import {
  interpretAsDocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type DocumentProgress,
  type QueryState,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import { subscribe } from "./index.js";
import { forwardingProxy } from "./forwarding-proxy.js";
import { OverlayHandle } from "./overlay-handle.js";
import { getScratchRepo } from "./scratch-repo.js";
import type { RepoLike } from "./types.js";

/**
 * Cloneable answer to a `repo:handle-descriptor` subscription.
 *
 * - `url` is the *presented* identity the consumer asked for; the resolved
 *   handle reports this url back even when it is backed by a clone.
 * - `cloneUrl`, when present, names the document the handle should actually
 *   read from and write to.
 *
 * Fork invariant: `cloneUrl` MUST be a fork of `url` (it shares `url`'s
 * history). Positional refs and cursors are resolved against the presented
 * url, so a `cloneUrl` that is not a fork would silently break ref/cursor
 * identity. Remappers are responsible for upholding this.
 *
 * The subscription is streaming: a remapper may emit a new descriptor at any
 * time and the overlay repo swaps the live handle's backing in place —
 * consumers keep the same wrapper and see a `change` with
 * `scopeReplaced: true`. One-shot providers remain fully supported.
 *
 * `scratchUrl`, when present, names a document in the realm's scratch repo
 * (see {@link getScratchRepo}) to show in place of `cloneUrl ?? url` while the
 * view is live: a throwaway document, never saved or synced, for remappers
 * that compute what a document shows rather than store it. Only its
 * documentId is used. It should start as a fork of `cloneUrl ?? url`, so refs
 * and cursors made on it resolve, but needn't go on sharing its history. So a
 * view pinned to heads (on the presented url, or stamped on `cloneUrl`) shows
 * `cloneUrl ?? url` at those heads, unless only the scratch document has them
 * (they were read off a view it backs), and then shows the scratch document
 * at those heads for as long as the descriptor names it.
 *
 * A scratch document has no peers, so a view it backs sends and hears peer
 * traffic through the stored document (`cloneUrl ?? url`) instead: its
 * `broadcast`, `getSyncInfo`, `getRemoteHeads` and `isCaughtUpWith`, and its
 * `ephemeral-message`, `ephemeral-message-outbound` and `remote-heads`
 * events, are those of the realm repo's handle for that document, once it's
 * found. Messages go as they are: peers on the stored document can't tell
 * they came from a view of a computed one, and any position in them (a
 * cursor, an index) is one in the scratch document.
 *
 * While a view is backed by a scratch document, its overlay repo holds a
 * `repo:scratch-lease` subscription for that document's url, opened before it
 * finds the document and closed once nothing forwards to it (after a swap to
 * another backing, or on dispose). A remapper that made the document can
 * claim those leases, but they don't cover the descriptor's trip across the
 * channel: the view only opens one once the answer arrives. So until then the
 * remapper keeps the document for its latest answer on each open
 * subscription, and deletes it when neither an answer nor a lease holds it.
 * One that keeps its scratch documents alive some other way can leave the
 * leases unclaimed.
 *
 * The descriptor crosses the `patchwork:subscribe` channel structured-cloned,
 * which is why it carries plain `AutomergeUrl` strings and never a live
 * `DocHandle`/`Repo`.
 */
export type DocHandleDescriptor = {
  url: AutomergeUrl;
  cloneUrl?: AutomergeUrl;
  scratchUrl?: AutomergeUrl;
};

// The only members whose behavior an overlay repo changes; everything else
// (create/create2/clone/delete, the EventEmitter surface, ...) forwards to the
// realm-local base repo.
const OVERLAY_REPO_OWNED: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  "baseRepo",
  "handles",
  "find",
  "findWithProgress",
  "create",
  "create2",
  "dispose",
]);

/**
 * A realm-local {@link RepoLike} shim that makes document resolution
 * remappable across provider scopes (including iframes) without sending a live
 * `Repo`/`DocHandle` over the wire.
 *
 * `find`/`findWithProgress` open a persistent `repo:handle-descriptor`
 * subscription for the requested url and resolve the returned
 * `cloneUrl ?? url` against the realm-local `baseRepo` (or `scratchUrl`
 * against {@link getScratchRepo}), then hand back an {@link OverlayHandle}
 * that keeps reporting the *original* url. Follow-up
 * descriptor emissions re-point the live wrapper via `swapBackingDocHandle`.
 * Every other method (`create`, `create2`, `clone`, `delete`, the
 * EventEmitter surface, ...) forwards to `baseRepo` unchanged — created docs
 * need no remapping.
 *
 * The owning element must call {@link dispose} on disconnect to release the
 * descriptor subscriptions.
 */
export class OverlayRepo implements RepoLike {
  readonly baseRepo: Repo;
  readonly #element: HTMLElement;
  // Keyed by the presented url's *root*: its documentId and any pinned heads,
  // never a path. A url with a path is that root's `sub(...)`, so it shares
  // the root's descriptor subscription, swaps with it, and is the same
  // wrapper as the root's own `sub` of that path, as in the real repo.
  readonly #wrapped = new Map<AutomergeUrl, OverlayHandle<unknown>>();
  readonly #inner = new Map<AutomergeUrl, DocumentProgress<unknown>>();
  readonly #resolving = new Map<
    AutomergeUrl,
    Promise<OverlayHandle<unknown>>
  >();
  // Live descriptor subscriptions, one per presented url.
  readonly #subscriptions = new Map<AutomergeUrl, () => void>();
  // Applied backing per presented url; skips no-op re-emissions. `stored` is
  // the document a scratch backing stands for, whose peers it uses.
  readonly #backings = new Map<
    AutomergeUrl,
    { repo: Repo; url: AutomergeUrl; stored?: DocumentId }
  >();
  // Per presented url, the wait for a stored document that wasn't loaded yet;
  // stopped when the backing moves on, or on dispose.
  readonly #storedWaits = new Map<AutomergeUrl, AbortController>();
  // Held `repo:scratch-lease` per presented url backed by a scratch document.
  readonly #leases = new Map<AutomergeUrl, () => void>();
  // Leases taken for a backing that's still being looked up.
  readonly #pendingLeases = new Set<() => void>();
  // Progress subscribers per presented url, mapped to their unsubscribe from
  // the current inner; re-wired on swap.
  readonly #progressDispatchers = new Map<
    AutomergeUrl,
    Map<() => void, () => void>
  >();
  // Why the latest attempt to resolve a presented url ended without a handle,
  // in the same `failed`/`unavailable` shape the realm-local repo reports. It
  // outlives the eviction of the rejected resolution (so `peek()` can still
  // report it) and is cleared when a retry starts or succeeds.
  readonly #failures = new Map<AutomergeUrl, QueryState<unknown>>();
  // Rejects each still-pending resolution; settles it on dispose.
  readonly #rejecters = new Map<AutomergeUrl, (err: Error) => void>();
  // After a failed resolution, a watch on the backing it was waiting for: the
  // real repo's query goes `ready` by itself when the document turns up, so
  // the overlay retries then rather than waiting for someone to ask again.
  readonly #recoveries = new Map<AutomergeUrl, () => void>();
  #disposed = false;

  constructor(baseRepo: Repo, element: HTMLElement) {
    this.baseRepo = baseRepo;
    this.#element = element;
    return forwardingProxy<OverlayRepo>(this, baseRepo, OVERLAY_REPO_OWNED);
  }

  // Only already-wrapped handles are exposed; unknown ids fall through to
  // `find`/`findWithProgress` so consumers never see an un-wrapped handle.
  // Like the real repo's, these are root handles: never a sub-handle or a
  // view pinned to heads.
  get handles(): Record<DocumentId, DocHandle<unknown>> {
    const out = {} as Record<DocumentId, DocHandle<unknown>>;
    for (const [root, wrapped] of this.#wrapped) {
      if (parseAutomergeUrl(root).heads) continue;
      out[wrapped.documentId] = wrapped as unknown as DocHandle<unknown>;
    }
    return out;
  }

  // `signal` cancels the wait, not the resolution, as in the real repo.
  async find<T>(
    id: AnyDocumentId,
    options: { signal?: AbortSignal } = {}
  ): Promise<DocHandle<T>> {
    const { signal } = options;
    signal?.throwIfAborted();
    const { root, segments } = splitUrl(presentedUrlOf(id));
    const wrapped =
      this.#wrapped.get(root) ?? (await abortable(this.#resolve(root), signal));
    return scope(wrapped, segments) as DocHandle<T>;
  }

  // Mirrors the realm-local repo's progress but reports `loading` until the
  // descriptor has arrived and the backing handle is wrapped — otherwise
  // consumers would briefly observe the un-wrapped (un-remapped) handle.
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const self = this;
    // Readiness is the root's; a path only scopes the ready handle, as the
    // real repo's `progressAtPath` does.
    const { root: presented, segments } = splitUrl(presentedUrlOf(id));
    const documentId = parseAutomergeUrl(presented).documentId;
    this.#resolve<T>(presented).catch(() => {});

    const peek = (): QueryState<T> => {
      const state = peekRoot();
      return state.state === "ready"
        ? { ...state, handle: scope(state.handle, segments) as DocHandle<T> }
        : state;
    };
    const peekRoot = (): QueryState<T> => {
      const failure = self.#failures.get(presented);
      if (failure) return failure as QueryState<T>;
      const inner = self.#inner.get(presented) as
        DocumentProgress<T> | undefined;
      if (!inner) return { state: "loading", sources: {} };
      const innerState = inner.peek();
      if (innerState.state !== "ready") return innerState;
      const wrapped = self.#wrapped.get(presented);
      if (!wrapped) {
        return { state: "loading", sources: innerState.sources };
      }
      return {
        state: "ready",
        handle: wrapped as unknown as DocHandle<T>,
        sources: innerState.sources,
      };
    };

    return {
      documentId,
      peek,
      subscribe: (callback) => {
        // Like the realm-local repo, only transitions are reported; the
        // current state is read with `peek()`.
        let closed = false;
        const signature = (state: QueryState<T>) =>
          state.state === "failed"
            ? `failed:${state.error.message}`
            : state.state;
        let last = signature(peek());
        const dispatch = () => {
          if (closed) return;
          const state = peek();
          const sig = signature(state);
          if (sig === last) return;
          last = sig;
          callback(state);
        };
        // Registered at once, not when the resolution settles, so a failure or
        // a later retry's success reaches subscribers that were waiting. The
        // registry also lets a backing swap re-wire this subscriber onto the
        // new inner.
        if (!self.#disposed)
          self.#registerProgressDispatcher(presented, dispatch);
        return () => {
          closed = true;
          self.#unregisterProgressDispatcher(presented, dispatch);
        };
      },
      // Read from the current state, not the first resolution's promise: a
      // progress that failed and has since recovered is ready now.
      whenReady: ({ signal } = {}) => {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const state = peek();
        if (state.state === "ready") return Promise.resolve(state.handle);
        return abortable(self.#resolve<T>(presented), signal).then(
          (wrapped) => scope(wrapped, segments) as DocHandle<T>
        );
      },
      // Deprecated; kept for pre-`peek()` consumers.
      get state() {
        return peek().state;
      },
      get progress() {
        return self.#inner.get(presented)?.progress;
      },
      get error() {
        const s = peek();
        return s.state === "failed" ? s.error : undefined;
      },
    };
  }

  // Plain local creates need no remapping; declared (rather than forwarded) so
  // the class still satisfies `RepoLike`.
  create<T>(initialValue?: T): DocHandle<T> {
    return this.baseRepo.create<T>(initialValue);
  }

  create2<T>(initialValue?: T): Promise<DocHandle<T>> {
    return this.baseRepo.create2<T>(initialValue);
  }

  /** Called by the owning element on disconnect; releases live resources. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Settled first so a tool awaiting `find` during unmount rejects instead
    // of hanging; the progress subscribers hear about it before they go.
    const disposedError = new Error("OverlayRepo disposed");
    for (const [presented, reject] of this.#rejecters) {
      this.#failures.set(presented, failedState(disposedError));
      reject(disposedError);
    }
    this.#rejecters.clear();
    for (const presented of [...this.#progressDispatchers.keys()]) {
      this.#notifyProgress(presented);
    }
    for (const stop of this.#recoveries.values()) stop();
    this.#recoveries.clear();
    for (const wait of this.#storedWaits.values()) wait.abort();
    this.#storedWaits.clear();
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    for (const dispatchers of this.#progressDispatchers.values()) {
      for (const unsubscribeInner of dispatchers.values()) unsubscribeInner();
    }
    this.#progressDispatchers.clear();
    for (const wrapped of this.#wrapped.values()) wrapped.dispose();
    this.#wrapped.clear();
    // Released only once the wrappers have stopped forwarding.
    for (const release of this.#leases.values()) release();
    this.#leases.clear();
    for (const release of this.#pendingLeases) release();
    this.#pendingLeases.clear();
    this.#inner.clear();
    this.#resolving.clear();
    this.#backings.clear();
  }

  // De-dupes concurrent resolutions: the first caller opens the persistent
  // descriptor subscription, everyone else awaits the same promise. Later
  // emissions swap the resolved wrapper's backing in place.
  #resolve<T>(presented: AutomergeUrl): Promise<OverlayHandle<T>> {
    const existing = this.#resolving.get(presented);
    if (existing) return existing as Promise<OverlayHandle<T>>;
    // Don't open subscriptions nobody will tear down; the element is gone.
    if (this.#disposed) {
      const error = new Error(
        "OverlayRepo is disposed; cannot resolve " + presented
      );
      this.#failures.set(presented, failedState(error));
      return Promise.reject(error);
    }
    // A retry starts from `loading`, as the repo's query does when a source
    // goes pending again.
    this.#recoveries.get(presented)?.();
    this.#recoveries.delete(presented);
    if (this.#failures.delete(presented)) this.#notifyProgress(presented);

    // The descriptor channel remaps whole documents, so ask about the root
    // and reapply the original heads onto whatever clone comes back. Paths
    // are applied by the wrapper's `sub`, never here (see `#wrapped`).
    const { documentId, heads } = parseAutomergeUrl(presented);
    const rootUrl = stringifyAutomergeUrl({ documentId });

    // Set by a failed `apply`: the inner's own `unavailable`/`failed` state
    // when it has one, since that is what the repo would have reported, and
    // the inner itself, to watch for the document turning up.
    let failure: QueryState<unknown> | undefined;
    let failedInner: DocumentProgress<unknown> | undefined;

    const promise = new Promise<OverlayHandle<T>>((resolve, reject) => {
      this.#rejecters.set(presented, reject);
      // Only the latest received descriptor may commit its backing.
      let seq = 0;

      const apply = async (descriptor: DocHandleDescriptor) => {
        const mySeq = ++seq;
        const backingRoot = descriptor.cloneUrl ?? descriptor.url;
        // A remapper may pin the backing to specific heads by stamping them
        // onto the returned url; honor them, but presented-url heads win.
        const parsedBacking = parseAutomergeUrl(backingRoot);
        const pinned = heads ?? parsedBacking.heads;
        const scratchId = await this.#scratchToShow(
          descriptor.scratchUrl,
          parsedBacking.documentId,
          pinned
        );
        if (mySeq !== seq || this.#disposed) return;
        const repo = scratchId ? getScratchRepo() : this.baseRepo;
        const backingUrl = stringifyAutomergeUrl({
          documentId: scratchId ?? parsedBacking.documentId,
          heads: pinned,
        });
        const storedId = scratchId ? parsedBacking.documentId : undefined;
        const applied = this.#backings.get(presented);
        if (applied?.repo === repo && applied.url === backingUrl) {
          // The same scratch document can stand for another stored one (a new
          // `cloneUrl`), and its peer traffic goes with that.
          if (applied.stored !== storedId) {
            applied.stored = storedId;
            this.#wrapped
              .get(presented)
              ?.setSyncHandle(this.#routeSync(presented, applied));
          }
          return;
        }

        // Held from before the find, so nothing lets go of the document
        // between this answer arriving and the backing being in use.
        const lease = scratchId
          ? subscribe(
              this.#element,
              {
                type: "repo:scratch-lease",
                url: stringifyAutomergeUrl({ documentId: scratchId }),
              },
              () => {}
            )
          : undefined;
        if (lease) this.#pendingLeases.add(lease);
        let inner: DocumentProgress<T> | undefined;
        let backing: DocHandle<T>;
        try {
          inner = repo.findWithProgress<T>(backingUrl);
          backing = await repo.find<T>(backingUrl);
        } catch (err) {
          lease?.();
          // A newer descriptor has taken over; its outcome is the one that
          // counts, so this one mustn't fail the resolution under it.
          if (mySeq !== seq) return;
          failure = failureOf(
            inner as DocumentProgress<unknown> | undefined,
            err
          );
          failedInner = inner as DocumentProgress<unknown> | undefined;
          throw err;
        } finally {
          if (lease) this.#pendingLeases.delete(lease);
        }
        if (mySeq !== seq || this.#disposed) {
          lease?.();
          return;
        }

        const appliedNow = { repo, url: backingUrl, stored: storedId };
        this.#backings.set(presented, appliedNow);
        this.#failures.delete(presented);
        this.#setInner(presented, inner as DocumentProgress<unknown>);
        // The previous lease goes only once nothing forwards to its
        // document, so the remapper deleting it can't reach consumers.
        const previous = this.#leases.get(presented);
        if (lease) this.#leases.set(presented, lease);
        else this.#leases.delete(presented);

        const sync = this.#routeSync(presented, appliedNow);

        const wrapped = this.#wrapped.get(presented) as
          OverlayHandle<T> | undefined;
        if (wrapped) {
          wrapped.swapBackingDocHandle(backing, sync);
        } else {
          const created = new OverlayHandle<T>({
            presentedUrl: presented,
            backing,
            sync,
          });
          this.#wrapped.set(presented, created as OverlayHandle<unknown>);
          this.#rejecters.delete(presented);
          resolve(created);
          this.#notifyProgress(presented);
        }
        previous?.();
      };

      const unsubscribe = subscribe<DocHandleDescriptor>(
        this.#element,
        { type: "repo:handle-descriptor", url: rootUrl },
        (descriptor) => {
          apply(descriptor).catch((err) => {
            // Only the initial resolution can fail the returned promise;
            // a failed re-map keeps the previous backing.
            if (!this.#wrapped.has(presented)) reject(err);
            else {
              console.error(
                `[patchwork-providers] failed to re-map ${presented}:`,
                err
              );
            }
          });
        }
      );
      this.#subscriptions.set(presented, unsubscribe);
    });

    // Only successful resolutions stay memoized. A rejection — typically
    // baseRepo.find reporting unavailable because the doc (or its keyhive
    // access) hasn't synced yet — is retryable, so caching it would pin every
    // future find() of this url to the same stale rejection and defeat the
    // views' "retry once access syncs" recovery. Evict so the next find()
    // re-runs the whole resolution. The identity check keeps a late-arriving
    // cleanup from clobbering a newer in-flight attempt.
    // The failed attempt's descriptor subscription goes too: the retry opens
    // its own and overwrites the map entry, which would leave this one live
    // and out of reach of `dispose`.
    promise.catch((error: Error) => {
      if (this.#resolving.get(presented) === promise) {
        this.#resolving.delete(presented);
        this.#rejecters.delete(presented);
        this.#inner.delete(presented);
        this.#failures.set(presented, failure ?? failedState(error));
        this.#subscriptions.get(presented)?.();
        this.#subscriptions.delete(presented);
        if (failedInner && !this.#disposed)
          this.#watchForRecovery(presented, failedInner);
        this.#notifyProgress(presented);
      }
    });

    this.#resolving.set(presented, promise as Promise<OverlayHandle<unknown>>);
    return promise;
  }

  // The scratch document to show, if any. A pinned view shows the stored
  // document, unless only the scratch one has those heads: they were read
  // off a view the scratch document backs. A document that can't be found
  // counts as not having them.
  async #scratchToShow(
    scratchUrl: AutomergeUrl | undefined,
    storedId: DocumentId,
    pinned: UrlHeads | undefined
  ): Promise<DocumentId | undefined> {
    if (!scratchUrl) return undefined;
    const scratchId = parseAutomergeUrl(scratchUrl).documentId;
    if (!pinned) return scratchId;
    const has = async (repo: Repo, documentId: DocumentId) => {
      try {
        const handle = await repo.find(stringifyAutomergeUrl({ documentId }));
        return handle.containsHeads(pinned);
      } catch {
        return false;
      }
    };
    if (!(await has(getScratchRepo(), scratchId))) return undefined;
    return (await has(this.baseRepo, storedId)) ? undefined : scratchId;
  }

  // Where a scratch-backed view's peer traffic goes: the realm repo's handle
  // for the stored document `applied` stands for. That's almost always loaded
  // already (it's what the scratch one was made from), so it's returned to be
  // routed with the swap; if not, it's routed once it's found, unless the
  // backing has moved on by then. Undefined leaves peer traffic on the
  // backing. Stops the wait an earlier backing left.
  #routeSync(
    presented: AutomergeUrl,
    applied: { stored?: DocumentId }
  ): DocHandle<unknown> | undefined {
    this.#storedWaits.get(presented)?.abort();
    this.#storedWaits.delete(presented);
    const storedId = applied.stored;
    if (!storedId) return undefined;
    const stored = this.baseRepo.findWithProgress(
      stringifyAutomergeUrl({ documentId: storedId })
    );
    const state = stored.peek();
    if (state.state === "ready") return state.handle;
    const wait = new AbortController();
    this.#storedWaits.set(presented, wait);
    const done = () => {
      if (this.#storedWaits.get(presented) === wait) {
        this.#storedWaits.delete(presented);
      }
    };
    stored.whenReady({ signal: wait.signal }).then(
      (handle) => {
        done();
        if (this.#backings.get(presented) !== applied) return;
        if (applied.stored !== storedId) return;
        this.#wrapped.get(presented)?.setSyncHandle(handle);
      },
      // Not found, or stopped: peer traffic stays where it is.
      done
    );
    return undefined;
  }

  // Attach a progress subscriber to the current inner (if any), keeping its
  // unsubscribe so `#setInner` can re-wire it on a swap.
  #registerProgressDispatcher(
    presented: AutomergeUrl,
    dispatch: () => void
  ): void {
    let dispatchers = this.#progressDispatchers.get(presented);
    if (!dispatchers) {
      dispatchers = new Map();
      this.#progressDispatchers.set(presented, dispatchers);
    }
    const inner = this.#inner.get(presented);
    dispatchers.set(dispatch, inner ? inner.subscribe(dispatch) : () => {});
  }

  #unregisterProgressDispatcher(
    presented: AutomergeUrl,
    dispatch: () => void
  ): void {
    const dispatchers = this.#progressDispatchers.get(presented);
    if (!dispatchers) return;
    dispatchers.get(dispatch)?.();
    dispatchers.delete(dispatch);
    if (dispatchers.size === 0) this.#progressDispatchers.delete(presented);
  }

  // Retry `presented` once the backing its failed resolution waited for goes
  // `ready` (an unavailable document arriving later), unless something else
  // has retried it first.
  #watchForRecovery(
    presented: AutomergeUrl,
    inner: DocumentProgress<unknown>
  ): void {
    const retry = () => {
      stop();
      if (this.#recoveries.get(presented) !== stop) return;
      this.#recoveries.delete(presented);
      this.#resolve(presented).catch(() => {});
    };
    const stop = inner.subscribe((state) => {
      if (state.state === "ready") retry();
    });
    this.#recoveries.set(presented, stop);
    if (inner.peek().state === "ready") retry();
  }

  // Tell every progress subscriber of a presented url to re-read its state.
  #notifyProgress(presented: AutomergeUrl): void {
    const dispatchers = this.#progressDispatchers.get(presented);
    if (!dispatchers) return;
    for (const dispatch of [...dispatchers.keys()]) dispatch();
  }

  // Replace the inner progress and move every registered subscriber onto it.
  #setInner(presented: AutomergeUrl, inner: DocumentProgress<unknown>): void {
    this.#inner.set(presented, inner);
    const dispatchers = this.#progressDispatchers.get(presented);
    if (!dispatchers) return;
    for (const [dispatch, unsubscribeOld] of dispatchers) {
      unsubscribeOld();
      dispatchers.set(dispatch, inner.subscribe(dispatch));
      dispatch();
    }
  }
}

function failedState(error: Error): QueryState<never> {
  return { state: "failed", error, sources: {} };
}

// What a failed resolution looks like to a progress subscriber: the repo's
// `unavailable` when the document just isn't there yet, otherwise `failed`.
function failureOf(
  inner: DocumentProgress<unknown> | undefined,
  error: unknown
): QueryState<never> {
  const err = error instanceof Error ? error : new Error(String(error));
  const state = inner?.peek();
  if (state?.state === "unavailable") return state;
  return { state: "failed", error: err, sources: state?.sources ?? {} };
}

// A presented url's root (documentId and pinned heads) and its path.
function splitUrl(presented: AutomergeUrl): {
  root: AutomergeUrl;
  segments: unknown[];
} {
  const { documentId, heads, segments = [] } = parseAutomergeUrl(presented);
  return { root: stringifyAutomergeUrl({ documentId, heads }), segments };
}

// The handle at `segments` under a root wrapper.
function scope(wrapped: object, segments: unknown[]): DocHandle<unknown> {
  const handle = wrapped as DocHandle<unknown> & {
    sub: (...s: unknown[]) => DocHandle<unknown>;
  };
  return segments.length > 0 ? handle.sub(...segments) : handle;
}

// `promise`, or `signal`'s reason if it aborts first.
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

// Canonicalize any id to its *presented* url, preserving the path suffix
// (`/a/@0/b`) and any pinned heads so sub-document and view-scoped urls keep
// their identity through the overlay. Plain document ids carry no path.
function presentedUrlOf(id: AnyDocumentId): AutomergeUrl {
  if (isValidAutomergeUrl(id)) {
    const { documentId, segments, heads } = parseAutomergeUrl(id);
    return stringifyAutomergeUrl({ documentId, segments, heads });
  }
  return stringifyAutomergeUrl({ documentId: interpretAsDocumentId(id) });
}
