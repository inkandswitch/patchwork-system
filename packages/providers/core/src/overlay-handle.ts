import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type PeerId,
  type SyncInfo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import { forwardingProxy } from "./forwarding-proxy.js";

type Listener = (...args: unknown[]) => void;
type Segments = NonNullable<ReturnType<typeof parseAutomergeUrl>["segments"]>;

// The only members whose behavior an overlay handle changes: the presented
// identity, the backing accessors (`backingHandle`/`swapBackingDocHandle`/
// `setSyncHandle`), the identity-preserving `sub`/`view` (derived urls stay
// in the presented space), url equality (`equals`), the argument-unwrapping
// comparisons (`merge`/`overlaps`/`contains`/`isChildOf`/`diff`), the peer
// members that go to the sync handle (`broadcast`/`getSyncInfo`), and the re-stamping EventEmitter
// surface. Everything else (doc/change/heads/ref/history/...) forwards to the
// backing handle.
const OVERLAY_HANDLE_OWNED: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  "url",
  "documentId",
  "backingHandle",
  "swapBackingDocHandle",
  "setSyncHandle",
  "sub",
  "view",
  "equals",
  "merge",
  "overlaps",
  "contains",
  "isChildOf",
  "diff",
  "broadcast",
  "getSyncInfo",
  "on",
  "off",
  "once",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "listenerCount",
  "listeners",
  "eventNames",
  "emit",
  "dispose",
]);

// Events about the document's peers rather than its contents, which
// automerge-repo 3 sends to every handle on the document; an overlay handle
// hears them from its sync handle (see `setSyncHandle`).
const PEER_EVENTS: ReadonlySet<string> = new Set([
  "ephemeral-message",
  "remote-heads",
]);

export type OverlayHandleOpts<T> = {
  presentedUrl: AutomergeUrl;
  backing: DocHandle<T>;
  /** Where peer traffic goes, when not to the backing; see `setSyncHandle`. */
  sync?: DocHandle<unknown>;
};

/**
 * How a derived handle is re-made on its root's next backing: a `view(heads)`
 * somewhere in its derivation (if any), then its path relative to the root.
 * The path is the one in the backing handle's url, so cursor ranges keep
 * their cursors (valid in any fork) rather than being re-placed by index.
 */
type Recipe = { heads?: UrlHeads; segments: Segments };

// Consumers hold the Proxy, which can't reach the target's private fields;
// this maps each Proxy back to its target.
const targets = new WeakMap<object, OverlayHandle<any>>();

type Family = Map<AutomergeUrl, WeakRef<OverlayHandle<unknown>>>;

// A backing event's forwarder, and the handle it's attached to.
type Forwarder = { fn: Listener; on: DocHandle<unknown> };

// Prunes a collected wrapper's entry from its root's family.
const collected = new FinalizationRegistry<{
  family: Family;
  url: AutomergeUrl;
}>(({ family, url }) => {
  if (family.get(url)?.deref() === undefined) family.delete(url);
});

/**
 * A url-hiding proxy around a swappable backing `DocHandle`. `url`/`documentId`
 * always report the *presented* url; every other operation forwards to the
 * current backing handle. Event subscriptions are tracked locally and the
 * backing handle's events are lazily forwarded with `payload.handle`
 * re-stamped to this wrapper, so consumers never observe the backing (clone)
 * handle or its url.
 *
 * Handles derived with `sub`/`view` are wrappers too, canonicalized like the
 * real repo's: the same presented url gives the same wrapper, however it was
 * reached, for as long as anything holds it (or listens to it).
 *
 * Remappers may re-point a live handle at a different backing via
 * {@link swapBackingDocHandle}: listeners are re-wired, derived handles
 * re-based, and a synthetic `change` with `scopeReplaced: true` tells
 * consumers to re-read `doc()` — the backings may be divergent forks with no
 * patch stream connecting them.
 *
 * Peer traffic (ephemeral messages, sync info, remote heads) goes to the
 * backing too, unless a sync handle is set ({@link setSyncHandle}): then to
 * that, for the root and every handle derived from it.
 */
export class OverlayHandle<T> {
  readonly #originalUrl: AutomergeUrl;
  #handle: DocHandle<T>;
  readonly #listeners = new Map<string, Set<Listener>>();
  // One forwarder per event with listeners, attached to the backing (or, for
  // a peer event, the sync handle); moved over when either changes, dropped
  // with the event's last listener.
  readonly #forwarders = new Map<string, Forwarder>();
  // The Proxy returned from the constructor — the object consumers actually
  // hold. Re-stamped onto forwarded events so identity stays consistent.
  readonly #self: OverlayHandle<T>;
  // The wrapper this one was derived from (itself, for one made directly),
  // and how to re-make this one on that wrapper's next backing.
  #root: OverlayHandle<unknown>;
  #recipe: Recipe = { segments: [] };
  // On a root: every live wrapper derived from it, by presented url. Held
  // weakly, as the real repo holds its sub-handles: a wrapper nothing holds
  // and nothing listens to can go.
  readonly #family: Family = new Map();
  // On a root: the handle peer traffic goes to instead of the backing, for
  // this wrapper and its family. Unset, each goes to its own backing.
  #sync: DocHandle<unknown> | undefined;
  // Set once this wrapper has stopped following any backing (disposed, or a
  // view its root's new backing couldn't make); it never forwards again.
  #detached = false;

  constructor(opts: OverlayHandleOpts<T>) {
    this.#originalUrl = opts.presentedUrl;
    this.#handle = opts.backing;
    this.#sync = opts.sync;
    this.#root = this as OverlayHandle<unknown>;
    this.#self = forwardingProxy<OverlayHandle<T>>(
      this,
      () => this.#handle,
      OVERLAY_HANDLE_OWNED
    );
    targets.set(this.#self, this);
    return this.#self;
  }

  get url(): AutomergeUrl {
    return this.#originalUrl;
  }

  get documentId(): DocumentId {
    return parseAutomergeUrl(this.#originalUrl).documentId;
  }

  /** @internal The live handle this wrapper currently forwards to. */
  get backingHandle(): DocHandle<T> {
    return this.#handle;
  }

  /**
   * @internal Re-point this wrapper and every handle derived from it at a new
   * backing, keeping presented and proxy identity intact. Emits a synthetic
   * `change` with `scopeReplaced: true` (and `heads-changed`, when the heads
   * move) so consumers reconcile from `doc()` instead of applying patches.
   * `sync` is the new backing's sync handle, as for {@link setSyncHandle}.
   */
  swapBackingDocHandle(next: DocHandle<T>, sync?: DocHandle<unknown>): void {
    if (next === this.#handle) {
      this.setSyncHandle(sync);
      return;
    }
    this.#sync = sync;
    const moved: [OverlayHandle<unknown>, DocHandle<unknown>][] = [
      [this as OverlayHandle<unknown>, this.#rebind(next)],
    ];
    for (const [url, ref] of this.#family) {
      const member = ref.deref();
      if (!member) {
        this.#family.delete(url);
        continue;
      }
      const target = targets.get(member)!;
      let remade: DocHandle<unknown> | undefined;
      try {
        remade = remake(next as DocHandle<any>, target.#recipe);
      } catch (err) {
        console.error(
          `[patchwork-providers] couldn't re-base ${url} on its new backing:`,
          err
        );
      }
      if (!remade) {
        // A view at heads the new backing doesn't have: it stays the snapshot
        // it was, but hears nothing more from a backing that may be going.
        target.#detach();
        this.#family.delete(url);
        continue;
      }
      if (remade === target.#handle) continue;
      moved.push([target, target.#rebind(remade)]);
    }
    // Every handle is re-pointed before anyone hears about it, and, as in a
    // real change, all hear `heads-changed` before any hears `change`.
    for (const [target, previous] of moved) {
      if (!sameHeads(previous.heads(), target.#handle.heads())) {
        target.emit("heads-changed", {
          handle: target.#self,
          doc: target.#handle.fullDoc(),
        });
      }
    }
    for (const [target, previous] of moved) {
      const after = target.#handle.fullDoc();
      target.emit("change", {
        handle: target.#self,
        doc: target.#handle.doc(),
        patches: [],
        scopeReplaced: true,
        patchInfo: { before: previous.fullDoc(), after, source: "change" },
      });
    }
  }

  /**
   * @internal Send this wrapper's and its family's peer traffic through
   * `sync` instead of their backings: `broadcast`, `getSyncInfo`,
   * and the `ephemeral-message`
   * and `remote-heads` events. For a backing
   * with no peers of its own, such as a scratch document, whose peers are
   * those of the stored document it's computed from. `undefined` goes back
   * to the backings.
   */
  setSyncHandle(sync: DocHandle<unknown> | undefined): void {
    const root = this.#root;
    if (root.#sync === sync) return;
    root.#sync = sync;
    root.#reattach();
    for (const ref of root.#family.values()) {
      const member = ref.deref();
      if (member) targets.get(member)!.#reattach();
    }
  }

  // Peers are the document's, so these read no path or heads: a derived
  // handle's are its root's.
  broadcast(message: unknown): void {
    this.#syncHandle().broadcast(message);
  }

  getSyncInfo(peerId: PeerId): SyncInfo | undefined {
    return this.#syncHandle().getSyncInfo(peerId);
  }

  // `equals` is url equality, and ours is the presented url.
  equals(other: DocHandle<unknown>): boolean {
    return this.#originalUrl === other.url;
  }

  // Handle comparisons read the *other* handle's internals (Automerge rejects
  // a foreign wrapper, `overlaps`/`contains` touch its private `#path`, and
  // `diff` tells handles from heads with `instanceof`), so unwrap an overlay
  // argument down to its backing before delegating.
  merge(other: DocHandle<T>): void {
    this.#handle.merge(unwrapHandle(other));
  }

  overlaps(other: DocHandle<unknown>): boolean {
    return this.#handle.overlaps(unwrapHandle(other));
  }

  contains(other: DocHandle<unknown>): boolean {
    return this.#handle.contains(unwrapHandle(other));
  }

  isChildOf(other: DocHandle<unknown>): boolean {
    return this.#handle.isChildOf(unwrapHandle(other));
  }

  diff(
    first: UrlHeads | DocHandle<T>,
    second?: UrlHeads
  ): ReturnType<DocHandle<T>["diff"]> {
    return this.#handle.diff(
      Array.isArray(first) ? first : unwrapHandle(first),
      second
    );
  }

  // Derived handles must keep reporting urls in the *presented* space;
  // otherwise a ref or cursor produced here (a comment target, a selection
  // cursor, ...) would leak the backing (clone) documentId and break identity
  // for consumers that resolve it back through the overlay. Reads/writes still
  // hit the backing's own sub-handle (or view).
  sub(...segments: unknown[]): DocHandle<unknown> {
    const backing = (
      this.#handle as unknown as {
        sub: (...s: unknown[]) => DocHandle<unknown>;
      }
    ).sub(...segments);
    return this.#derive(backing, this.#recipe.heads);
  }

  view(heads: UrlHeads): DocHandle<T> {
    return this.#derive(
      this.#handle.view(heads) as DocHandle<unknown>,
      heads
    ) as DocHandle<T>;
  }

  on(ev: string, fn: Listener): OverlayHandle<T> {
    let set = this.#listeners.get(ev);
    if (!set) {
      set = new Set();
      this.#listeners.set(ev, set);
    }
    set.add(fn);
    this.#forward(ev);
    return this.#self;
  }

  // As in the real handle, `off(ev)` with no listener removes all of them.
  off(ev: string, fn?: Listener): OverlayHandle<T> {
    const set = this.#listeners.get(ev);
    if (!set) return this.#self;
    if (fn) set.delete(fn);
    else set.clear();
    if (set.size === 0) {
      this.#listeners.delete(ev);
      this.#unforward(ev);
    }
    return this.#self;
  }

  once(ev: string, fn: Listener): OverlayHandle<T> {
    const wrapper: Listener = (...args) => {
      this.off(ev, wrapper);
      fn(...args);
    };
    return this.on(ev, wrapper);
  }

  addListener(ev: string, fn: Listener): OverlayHandle<T> {
    return this.on(ev, fn);
  }

  removeListener(ev: string, fn?: Listener): OverlayHandle<T> {
    return this.off(ev, fn);
  }

  removeAllListeners(ev?: string): OverlayHandle<T> {
    if (ev !== undefined) return this.off(ev);
    for (const event of [...this.#listeners.keys()]) this.off(event);
    return this.#self;
  }

  listenerCount(ev: string): number {
    return this.#listeners.get(ev)?.size ?? 0;
  }

  listeners(ev: string): Listener[] {
    return [...(this.#listeners.get(ev) ?? [])];
  }

  eventNames(): string[] {
    return [...this.#listeners.keys()];
  }

  // Two deliberate departures from Node's EventEmitter: listener errors are
  // logged rather than rethrown, so one failing consumer doesn't starve the
  // rest; and listeners unsubscribed *during* the emit are skipped — a
  // scopeReplaced consumer may tear down a later listener mid-emit (e.g.
  // codemirror replacing its sync plugin), and invoking it anyway would
  // re-apply state it already handed off.
  emit(ev: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(ev);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      if (!set.has(fn)) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error(
          `[patchwork-providers] "${ev}" listener on ${this.#originalUrl} threw:`,
          err
        );
      }
    }
    return true;
  }

  dispose(): void {
    this.#detach();
    this.#listeners.clear();
    for (const ref of this.#family.values()) ref.deref()?.dispose();
    this.#family.clear();
  }

  // The wrapper for `backing`, a handle derived from ours: ourselves if it's
  // our own backing, else the root's live wrapper for its presented url, else
  // a new one.
  #derive(
    backing: DocHandle<unknown>,
    heads: UrlHeads | undefined
  ): DocHandle<unknown> {
    const root = this.#root;
    const recipe: Recipe = {
      heads,
      segments: relativeSegments(backing.url, root.#handle.url),
    };
    const url = presentedUrlOf(root.#originalUrl, recipe);
    if (
      backing === (this.#handle as DocHandle<unknown>) &&
      url === this.#originalUrl
    ) {
      return this.#self as unknown as DocHandle<unknown>;
    }
    if (url === root.#originalUrl) {
      return root.#self as unknown as DocHandle<unknown>;
    }
    const live = root.#family.get(url)?.deref();
    if (live) return live as unknown as DocHandle<unknown>;
    const member = new OverlayHandle<unknown>({ presentedUrl: url, backing });
    const target = targets.get(member)!;
    target.#root = root;
    target.#recipe = recipe;
    root.#family.set(url, new WeakRef(member));
    collected.register(member, { family: root.#family, url });
    return member as unknown as DocHandle<unknown>;
  }

  // Point at `next`, moving the forwarders over; returns the old backing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #rebind(next: DocHandle<any>): DocHandle<unknown> {
    const previous = this.#handle as DocHandle<unknown>;
    this.#handle = next as DocHandle<T>;
    this.#reattach();
    return previous;
  }

  // Where peer traffic goes: the root's sync handle, else the backing.
  #syncHandle(): DocHandle<unknown> {
    return this.#root.#sync ?? (this.#handle as DocHandle<unknown>);
  }

  // Where `ev`'s forwarder belongs: the sync handle for peer events, else
  // the backing.
  #sourceOf(ev: string): DocHandle<unknown> {
    return PEER_EVENTS.has(ev)
      ? this.#syncHandle()
      : (this.#handle as DocHandle<unknown>);
  }

  // Move each forwarder to where it now belongs.
  #reattach(): void {
    for (const [ev, forwarder] of this.#forwarders) {
      const on = this.#sourceOf(ev);
      if (on === forwarder.on) continue;
      emitter(forwarder.on).off(ev, forwarder.fn);
      emitter(on).on(ev, forwarder.fn);
      forwarder.on = on;
    }
  }

  // Stop forwarding anything, for good.
  #detach(): void {
    this.#detached = true;
    for (const [ev, forwarder] of this.#forwarders) {
      emitter(forwarder.on).off(ev, forwarder.fn);
    }
    this.#forwarders.clear();
  }

  // Lazily forward a backing (or sync handle) event while someone listens for
  // it, re-stamping `payload.handle = this wrapper` so consumers see the
  // wrapper rather than the backing handle as the event source. While
  // attached, the forwarder also keeps this wrapper alive, as a listener
  // keeps a real handle alive.
  #forward(ev: string): void {
    if (this.#detached || this.#forwarders.has(ev)) return;
    const fn: Listener = (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "handle" in (payload as Record<string, unknown>)
      ) {
        this.emit(ev, { ...(payload as object), handle: this.#self });
      } else {
        this.emit(ev, payload);
      }
    };
    const on = this.#sourceOf(ev);
    this.#forwarders.set(ev, { fn, on });
    emitter(on).on(ev, fn);
  }

  #unforward(ev: string): void {
    const forwarder = this.#forwarders.get(ev);
    if (!forwarder) return;
    emitter(forwarder.on).off(ev, forwarder.fn);
    this.#forwarders.delete(ev);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitter(handle: DocHandle<any>) {
  return handle as unknown as {
    on(ev: string, fn: Listener): void;
    off(ev: string, fn: Listener): void;
  };
}

// The derived handle `recipe` names, on a root's new backing; `undefined` for
// a view at heads that backing doesn't have.
function remake(
  backing: DocHandle<unknown>,
  recipe: Recipe
): DocHandle<unknown> | undefined {
  let handle = backing;
  if (recipe.heads) {
    if (!handle.hasHeads(recipe.heads)) return undefined;
    handle = handle.view(recipe.heads);
  }
  if (recipe.segments.length > 0) {
    handle = (
      handle as unknown as { sub: (...s: unknown[]) => DocHandle<unknown> }
    ).sub(...recipe.segments);
  }
  return handle;
}

// `url`'s path past `rootUrl`'s; a derived handle's path starts with its
// root's.
function relativeSegments(url: AutomergeUrl, rootUrl: AutomergeUrl): Segments {
  const segments = parseAutomergeUrl(url).segments ?? [];
  const rootSegments = parseAutomergeUrl(rootUrl).segments ?? [];
  return segments.slice(rootSegments.length);
}

// A derived handle's presented url: the presented root's document, the
// recipe's view heads (else the root's own), and the root's path extended by
// the recipe's. Built from the presented root rather than the backing's url,
// so heads a remapper stamped on its backing don't leak into derived urls.
function presentedUrlOf(root: AutomergeUrl, recipe: Recipe): AutomergeUrl {
  const { documentId, segments = [], heads } = parseAutomergeUrl(root);
  const path = [...segments, ...recipe.segments];
  return stringifyAutomergeUrl({
    documentId,
    heads: recipe.heads ?? heads,
    segments: path.length > 0 ? path : undefined,
  });
}

function sameHeads(a: UrlHeads, b: UrlHeads): boolean {
  return a.length === b.length && a.every((head, i) => head === b[i]);
}

// Unwrap an overlay wrapper down to its backing handle. Plain handles pass
// through untouched.
function unwrapHandle<T>(handle: DocHandle<T>): DocHandle<T> {
  return (targets.get(handle)?.backingHandle as DocHandle<T>) ?? handle;
}
