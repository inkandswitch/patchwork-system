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
} from "@automerge/automerge-repo";

import { subscribe } from "./index.js";
import { forwardingProxy } from "./forwarding-proxy.js";
import { OverlayHandle } from "./overlay-handle.js";
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
 * The descriptor crosses the `patchwork:subscribe` channel structured-cloned,
 * which is why it carries plain `AutomergeUrl` strings and never a live
 * `DocHandle`/`Repo`.
 */
export type DocHandleDescriptor = {
  url: AutomergeUrl;
  cloneUrl?: AutomergeUrl;
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
 * `cloneUrl ?? url` against the realm-local `baseRepo`, then hand back an
 * {@link OverlayHandle} that keeps reporting the *original* url. Follow-up
 * descriptor emissions re-point the live wrapper via `swapBacking`. Every
 * other method (`create`, `create2`, `clone`, `delete`, the EventEmitter
 * surface, ...) forwards to `baseRepo` unchanged — created docs need no
 * remapping.
 *
 * The owning element must call {@link dispose} on disconnect to release the
 * descriptor subscriptions.
 */
export class OverlayRepo implements RepoLike {
  readonly baseRepo: Repo;
  readonly #element: HTMLElement;
  // Keyed by the *presented* url (documentId + path + heads), not just the
  // documentId, so distinct sub-document paths under the same root document
  // don't collide.
  readonly #wrapped = new Map<AutomergeUrl, OverlayHandle<unknown>>();
  readonly #inner = new Map<AutomergeUrl, DocumentProgress<unknown>>();
  readonly #resolving = new Map<
    AutomergeUrl,
    Promise<OverlayHandle<unknown>>
  >();
  // Live descriptor subscriptions, one per presented url.
  readonly #subscriptions = new Map<AutomergeUrl, () => void>();
  // Applied backing url per presented url; skips no-op re-emissions.
  readonly #backingUrls = new Map<AutomergeUrl, AutomergeUrl>();
  // Progress subscribers per presented url, mapped to their unsubscribe from
  // the current inner; re-wired on swap.
  readonly #progressDispatchers = new Map<
    AutomergeUrl,
    Map<() => void, () => void>
  >();
  #disposed = false;

  constructor(baseRepo: Repo, element: HTMLElement) {
    this.baseRepo = baseRepo;
    this.#element = element;
    return forwardingProxy<OverlayRepo>(this, baseRepo, OVERLAY_REPO_OWNED);
  }

  // Only already-wrapped handles are exposed; unknown ids fall through to
  // `find`/`findWithProgress` so consumers never see an un-wrapped handle.
  // `#wrapped` is keyed by presented url, so derive the documentId from each
  // handle; sub-handles of the same root collapse onto a single entry (the
  // `Record<DocumentId, ...>` shape can't represent paths).
  get handles(): Record<DocumentId, DocHandle<unknown>> {
    const out = {} as Record<DocumentId, DocHandle<unknown>>;
    for (const wrapped of this.#wrapped.values()) {
      out[wrapped.documentId] = wrapped as unknown as DocHandle<unknown>;
    }
    return out;
  }

  async find<T>(id: AnyDocumentId): Promise<DocHandle<T>> {
    const presented = presentedUrlOf(id);
    const cached = this.#wrapped.get(presented);
    if (cached) return cached as unknown as DocHandle<T>;
    const wrapped = await this.#resolve<T>(presented);
    return wrapped as unknown as DocHandle<T>;
  }

  // Mirrors the realm-local repo's progress but reports `loading` until the
  // descriptor has arrived and the backing handle is wrapped — otherwise
  // consumers would briefly observe the un-wrapped (un-remapped) handle.
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const self = this;
    const presented = presentedUrlOf(id);
    // The reported `documentId` is the root id — `DocumentId` can't encode a
    // path — but caches are keyed by the full presented url.
    const documentId = parseAutomergeUrl(presented).documentId;
    const wrappedPromise = this.#resolve<T>(presented);
    wrappedPromise.catch(() => {});

    const peek = (): QueryState<T> => {
      const inner = self.#inner.get(presented) as
        | DocumentProgress<T>
        | undefined;
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
        // `closed` covers the unsubscribe-before-resolve race: without it the
        // resolution settling later would still subscribe to the inner
        // progress (leaking that subscription forever) and invoke the
        // consumer's callback after it unsubscribed.
        let closed = false;
        let last: string | null = null;
        let registered = false;
        const dispatch = () => {
          if (closed) return;
          const state = peek();
          const sig =
            state.state === "failed"
              ? `failed:${state.error.message}`
              : state.state;
          if (sig === last) return;
          last = sig;
          callback(state);
        };
        // Registered via the dispatcher registry (not on the inner directly)
        // so a backing swap can re-wire this subscriber onto the new inner.
        wrappedPromise.then(() => {
          if (closed) return;
          self.#registerProgressDispatcher(presented, dispatch);
          registered = true;
          dispatch();
        }, dispatch);
        return () => {
          closed = true;
          if (registered) {
            self.#unregisterProgressDispatcher(presented, dispatch);
          }
        };
      },
      whenReady: ({ signal } = {}) => {
        const handlePromise = wrappedPromise as unknown as Promise<
          DocHandle<T>
        >;
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (!signal) return handlePromise;
        return new Promise<DocHandle<T>>((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          handlePromise.then(
            (handle) => {
              signal.removeEventListener("abort", onAbort);
              resolve(handle);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            }
          );
        });
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
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    for (const dispatchers of this.#progressDispatchers.values()) {
      for (const unsubscribeInner of dispatchers.values()) unsubscribeInner();
    }
    this.#progressDispatchers.clear();
    for (const wrapped of this.#wrapped.values()) wrapped.dispose();
    this.#wrapped.clear();
    this.#inner.clear();
    this.#resolving.clear();
    this.#backingUrls.clear();
  }

  // De-dupes concurrent resolutions: the first caller opens the persistent
  // descriptor subscription, everyone else awaits the same promise. Later
  // emissions swap the resolved wrapper's backing in place.
  #resolve<T>(presented: AutomergeUrl): Promise<OverlayHandle<T>> {
    const existing = this.#resolving.get(presented);
    if (existing) return existing as Promise<OverlayHandle<T>>;
    // Don't open subscriptions nobody will tear down; the element is gone.
    if (this.#disposed) {
      return Promise.reject(
        new Error("OverlayRepo is disposed; cannot resolve " + presented)
      );
    }

    // The descriptor channel remaps whole documents, so ask about the root
    // and reapply the original path/heads onto whatever clone comes back.
    // The clone is a fork of the root, so the same sub-tree exists in it.
    const { documentId, segments, heads } = parseAutomergeUrl(presented);
    const rootUrl = stringifyAutomergeUrl({ documentId });

    const promise = new Promise<OverlayHandle<T>>((resolve, reject) => {
      // Only the latest received descriptor may commit its backing.
      let seq = 0;

      const apply = async (descriptor: DocHandleDescriptor) => {
        const mySeq = ++seq;
        const backingRoot = descriptor.cloneUrl ?? descriptor.url;
        // A remapper may pin the backing to specific heads by stamping them
        // onto the returned url; honor them, but presented-url heads win.
        const parsedBacking = parseAutomergeUrl(backingRoot);
        const backingUrl = stringifyAutomergeUrl({
          documentId: parsedBacking.documentId,
          segments,
          heads: heads ?? parsedBacking.heads,
        });
        if (this.#backingUrls.get(presented) === backingUrl) return;

        const inner = this.baseRepo.findWithProgress<T>(backingUrl);
        const backing = await this.baseRepo.find<T>(backingUrl);
        if (mySeq !== seq || this.#disposed) return;

        this.#backingUrls.set(presented, backingUrl);
        this.#setInner(presented, inner as DocumentProgress<unknown>);

        const wrapped = this.#wrapped.get(presented) as
          | OverlayHandle<T>
          | undefined;
        if (wrapped) {
          wrapped.swapBacking(backing);
          return;
        }
        const created = new OverlayHandle<T>({
          presentedUrl: presented,
          backing,
        });
        this.#wrapped.set(presented, created as OverlayHandle<unknown>);
        resolve(created);
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
    promise.catch(() => {
      if (this.#resolving.get(presented) === promise) {
        this.#resolving.delete(presented);
        this.#inner.delete(presented);
      }
    });

    this.#resolving.set(presented, promise as Promise<OverlayHandle<unknown>>);
    return promise;
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
