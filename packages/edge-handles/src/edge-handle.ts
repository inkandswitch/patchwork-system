/**
 * EdgeHandle — a doc-backed reactive cell with named source and target
 * connections to refs and other edges.
 *
 * The doc holds the persistent wiring (`source` and `target` maps, plus
 * optional value persistence). The class is its live in-memory presence.
 * EdgeHandles run no computation of their own; transforms are external
 * code that subscribes to `onSourceChange` / `onMembersChange` (or the
 * `onAnyChange` sugar) and writes back through `change`.
 *
 *     edge.value()                                  // current value
 *     edge.change(fnOrValue)                        // Ref.change shape
 *     edge.onValueChange(cb)                        // self value moved
 *
 *     edge.source / edge.target                     // resolved handles
 *     edge.sourceErrors / edge.targetErrors         // per-name errors
 *     edge.onSourceChange(cb)                       // (value, key): per-source
 *                                                   //   emit, both args defined
 *     edge.onMembersChange(cb)                      // (): membership changed
 *                                                   //   (fires on subscribe)
 *     edge.onAnyChange(cb)                          // sugar: either of the
 *                                                   //   above, (value?, key?)
 *
 *     edge.setSource(name, handle) / removeSource(name)
 *     edge.setTarget(name, handle) / removeTarget(name)
 *
 *     edge.persisted() / edge.setPersisted(on)      // doc-mirror policy
 *
 *     edge.destroy()                                // explicit teardown
 *
 * Live state is GC-able: unreferenced edges are collected, doc/endpoint
 * listeners get torn down by a FinalizationRegistry, the cache holds only
 * WeakRefs. You don't have to `destroy()` in normal flow.
 */

import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type SubChangeFn,
} from "@automerge/automerge-repo/slim";

// ─── subscriber set ────────────────────────────────────────────────────────

class SubscriberSet<T = unknown> {
  #subs = new Set<(value: T) => void>();
  add(cb: (value: T) => void): () => void {
    this.#subs.add(cb);
    return () => {
      this.#subs.delete(cb);
    };
  }
  notify(value: T): void {
    for (const cb of this.#subs) cb(value);
  }
}

// ─── doc shape ─────────────────────────────────────────────────────────────

/** `@patchwork.type` value used by EdgeHandle docs. */
export const EDGE_HANDLE_DATATYPE = "edge-handle";

/**
 * Serialized URL of a `Handle`. A plain `automerge:<docId>` addresses a whole
 * doc/edge; an `automerge:<docId>/<path>` addresses a sub-tree (what used to
 * be a `Ref`). Both are `AutomergeUrl` now that sub-handles are `DocHandle`s.
 */
export type HandleUrl = AutomergeUrl;

/**
 * On-disk shape of an EdgeHandle doc.
 *
 * `persist` and `value` are independent optional fields:
 *  - `persist: true` makes `change()` mirror its writes to `value`.
 *  - `value` holds the last persisted value when `persist` is on.
 */
export interface EdgeHandleDoc {
  "@patchwork": { type: typeof EDGE_HANDLE_DATATYPE; version: 1 };
  /** Upstream handle URLs keyed by local name. */
  source: { [name: string]: HandleUrl };
  /** Downstream handle URLs keyed by local name. */
  target: { [name: string]: HandleUrl };
  /** When true, `change()` writes the value back to `value`. */
  persist?: boolean;
  /** Mirrored value when persistence is on. */
  value?: unknown;
}

// ─── handle interface ──────────────────────────────────────────────────────

/**
 * What can sit at either end of an edge in memory: anything with a URL, a
 * value getter, and a change subscription. `EdgeHandle` implements it, so
 * edges can chain into edges; {@link DocHandleEndpoint} adapts a plain
 * `DocHandle` (doc or sub-tree) to the same shape.
 */
export interface Handle<T = unknown> {
  readonly url: HandleUrl;
  value(): T;
  change(fnOrValue: SubChangeFn<T> | T): void;
  onChange(cb: (value: T) => void): () => void;
}

/**
 * Adapts a `DocHandle` (a whole doc or a `.sub()` sub-tree) to the {@link Handle}
 * interface. Sub-handles replace the old `Ref` concept: reads (`doc()`),
 * writes (`change()`) and `change` events are all scoped to the handle's path.
 */
class DocHandleEndpoint<T = unknown> implements Handle<T> {
  constructor(private readonly handle: DocHandle<T>) {}

  get url(): HandleUrl {
    return this.handle.url;
  }

  value(): T {
    return this.handle.doc() as T;
  }

  change(fnOrValue: SubChangeFn<T> | T): void {
    this.handle.change(fnOrValue as never);
  }

  onChange(cb: (value: T) => void): () => void {
    const listener = () => cb(this.handle.doc() as T);
    this.handle.on("change", listener);
    return () => this.handle.off("change", listener);
  }
}

// ─── url validation ────────────────────────────────────────────────────────

const URL_PREFIX = "automerge:";

type HandleUrlKind = "doc-or-edge" | "ref" | "invalid";

/** Cheap, IO-free classification of a handle URL. */
function classifyHandleUrl(url: string): HandleUrlKind {
  if (!url.startsWith(URL_PREFIX)) return "invalid";
  const rest = url.slice(URL_PREFIX.length);
  if (rest.length === 0) return "invalid";
  const hashIx = rest.indexOf("#");
  const beforeHash = hashIx === -1 ? rest : rest.slice(0, hashIx);
  return beforeHash.includes("/") ? "ref" : "doc-or-edge";
}

/** Validate that a string is a syntactically well-formed handle URL. */
function isValidHandleUrl(url: string): boolean {
  const kind = classifyHandleUrl(url);
  if (kind === "invalid") return false;
  // Extract the documentId portion and validate it with the canonical check.
  const rest = url.slice(URL_PREFIX.length);
  const stops: number[] = [];
  const slashIx = rest.indexOf("/");
  const hashIx = rest.indexOf("#");
  if (slashIx >= 0) stops.push(slashIx);
  if (hashIx >= 0) stops.push(hashIx);
  const endIx = stops.length === 0 ? rest.length : Math.min(...stops);
  const docUrl = `${URL_PREFIX}${rest.slice(0, endIx)}`;
  return isValidAutomergeUrl(docUrl);
}

function assertValidHandleUrl(url: string): asserts url is HandleUrl {
  if (!isValidHandleUrl(url)) {
    throw new Error(`[edge-handles] invalid handle URL: ${JSON.stringify(url)}`);
  }
}

/**
 * Anything that can be handed in as an edge endpoint: a {@link Handle}
 * (`EdgeHandle` or a {@link DocHandleEndpoint}), a raw `DocHandle` /
 * sub-handle (addressed by its `url`), or a serialized {@link HandleUrl}.
 */
export type HandleInput = Handle | DocHandle<unknown> | HandleUrl;

function toHandleUrl(h: HandleInput): HandleUrl {
  return typeof h === "string" ? h : (h.url as HandleUrl);
}

// ─── GC-safe teardown registry ─────────────────────────────────────────────

interface TeardownBundle {
  doc: DocHandle<EdgeHandleDoc>;
  onDocChange: () => void;
  sourceUnsubs: Map<string, () => void>;
  repo: Repo;
  url: AutomergeUrl;
}

const finalRegistry = new FinalizationRegistry<TeardownBundle>(
  ({ doc, onDocChange, sourceUnsubs, repo, url }) => {
    try {
      doc.off("change", onDocChange);
    } catch {
      // doc may already be torn down — ignore
    }
    for (const u of sourceUnsubs.values()) {
      try {
        u();
      } catch {
        // best-effort
      }
    }
    // The cache entry, if any, is a WeakRef pointing at the collected edge;
    // remove the dead pointer so the next `find` doesn't bother dereffing.
    const cache = resolvedByRepo.get(repo);
    if (cache && cache.get(url)?.deref() === undefined) {
      cache.delete(url);
    }
  }
);

// ─── EdgeHandle class ──────────────────────────────────────────────────────

export class EdgeHandle<TValue = unknown>
  implements Handle<TValue | undefined>
{
  readonly repo: Repo;
  readonly doc: DocHandle<EdgeHandleDoc>;
  readonly url: AutomergeUrl;

  /** Live, resolved upstream handles keyed by local name. */
  source: Record<string, Handle> = {};
  /** Live, resolved downstream handles keyed by local name. */
  target: Record<string, Handle> = {};
  /** Resolution errors keyed by source name. Empty when everything resolved. */
  sourceErrors: Record<string, Error> = {};
  /**
   * Errors keyed by target name. Resolution errors (URL didn't resolve to a
   * live handle) and fan-out errors (write threw) share this map; both clear
   * when their cause is resolved.
   */
  targetErrors: Record<string, Error> = {};

  #value: TValue | undefined = undefined;
  #persisted = false;
  #valueSubscribers = new SubscriberSet<TValue | undefined>();
  #sourceSubscribers = new SubscriberSet<{ value: unknown; key: string }>();
  #membersSubscribers = new SubscriberSet<void>();
  #sourceUnsubs = new Map<string, () => void>();
  #docUnsub: (() => void) | null = null;
  #destroyed = false;
  #refreshGen = 0;
  /** Re-entrancy guard so cycles can't blow the stack at write time. */
  #writing = false;
  #lastSourceJson = "";
  #lastTargetJson = "";
  #initVisited: Set<string>;
  /** Used by listener closures so they don't pin `this` and block GC. */
  #self: WeakRef<EdgeHandle<TValue>>;

  /** @internal Use {@link createEdgeHandle} or {@link findEdgeHandle}. */
  constructor(
    repo: Repo,
    doc: DocHandle<EdgeHandleDoc>,
    options: { visited?: Set<string> } = {}
  ) {
    this.repo = repo;
    this.doc = doc;
    this.url = doc.url;
    this.#initVisited = options.visited ?? new Set<string>();
    this.#initVisited.add(doc.url);
    this.#self = new WeakRef(this);
  }

  /** @internal Resolve handles and start watching the doc. */
  async _init(): Promise<void> {
    let initial: EdgeHandleDoc | undefined;
    try {
      initial = this.doc.doc();
    } catch {
      // unavailable / deleted — leave persisted=false, refresh will bail
    }
    if (initial?.persist === true) {
      this.#persisted = true;
      if ("value" in initial) this.#value = initial.value as TValue;
    }

    // Listener closure captures a WeakRef so it doesn't keep `this` alive.
    // The DocHandle (long-lived via the Repo) would otherwise pin the edge.
    const self = this.#self;
    const onDocChange = () => {
      const e = self.deref();
      if (e) void e.#refreshEndpoints();
    };
    this.doc.on("change", onDocChange);
    this.#docUnsub = () => this.doc.off("change", onDocChange);

    finalRegistry.register(this, {
      doc: this.doc,
      onDocChange,
      sourceUnsubs: this.#sourceUnsubs,
      repo: this.repo,
      url: this.url,
    });

    await this.#refreshEndpoints();
  }

  // ── value side ──────────────────────────────────────────────────────────

  value(): TValue | undefined {
    return this.#value;
  }

  /**
   * Set or mutate the value. Same shape as `Ref.change`:
   *  - direct value: replaces.
   *  - callback `(prev) => next | void`: returning void leaves the value
   *    unchanged; returning a value replaces.
   *
   * When persistence is on, writes the new value back to the doc. Fans out
   * to every target (including writes of `undefined` — what targets do with
   * a clear is their concern, not the cell's). Re-entrant calls during
   * fan-out (cycles) are dropped.
   */
  change(fnOrValue: SubChangeFn<TValue | undefined> | TValue | undefined): void {
    if (this.#destroyed) return;
    if (this.#writing) {
      console.warn(
        `[edge-handles] re-entrant change() on ${this.url} dropped (cycle)`
      );
      return;
    }
    this.#writing = true;
    try {
      let next: TValue | undefined;
      if (typeof fnOrValue === "function") {
        const cb = fnOrValue as (v: TValue | undefined) => TValue | void;
        const result = cb(this.#value);
        next = result === undefined ? this.#value : result;
      } else {
        next = fnOrValue;
      }
      this.#value = next;
      if (this.#persisted) {
        this.doc.change((d) => {
          if (next === undefined) {
            delete (d as { value?: unknown }).value;
          } else {
            (d as { value?: unknown }).value = next;
          }
        });
      }
      this.#fanOut(next);
      this.#valueSubscribers.notify(next);
    } finally {
      this.#writing = false;
    }
  }

  /** Subscribe to changes to this edge's value. Fires with the current
   *  value on subscribe. */
  onValueChange(cb: (value: TValue | undefined) => void): () => void {
    const unsub = this.#valueSubscribers.add(cb);
    cb(this.#value);
    return unsub;
  }

  /** Handle conformance — alias for {@link onValueChange}. */
  onChange(cb: (value: TValue | undefined) => void): () => void {
    return this.onValueChange(cb);
  }

  // ── wire side ───────────────────────────────────────────────────────────

  /**
   * Fires when a specific source's value emits. Both `value` and `key` are
   * always defined. Does NOT fire on initial subscribe and does NOT fire on
   * membership changes — see {@link onMembersChange} for those.
   */
  onSourceChange(cb: (value: unknown, key: string) => void): () => void {
    return this.#sourceSubscribers.add(({ value, key }) => cb(value, key));
  }

  /**
   * Fires on initial subscribe and whenever source/target membership changes.
   * The new wiring is on `edge.source` / `edge.target` by the time it fires.
   *
   * Most transforms want to recompute on any upstream change — they subscribe
   * to both `onSourceChange` and `onMembersChange` with the same callback,
   * or use the {@link onAnyChange} sugar.
   */
  onMembersChange(cb: () => void): () => void {
    const unsub = this.#membersSubscribers.add(cb);
    cb();
    return unsub;
  }

  /**
   * Sugar combining `onSourceChange` and `onMembersChange`. Fires on:
   *  - initial subscribe — `cb(undefined, undefined)`
   *  - membership changes — `cb(undefined, undefined)`
   *  - per-source value emissions — `cb(value, key)`
   *
   * Use this when you just want "recompute on any upstream change" and
   * don't care which kind. Use the precise pair when you do care.
   */
  onAnyChange(
    cb: (value: unknown, key: string | undefined) => void
  ): () => void {
    const u1 = this.onSourceChange((value, key) => cb(value, key));
    const u2 = this.onMembersChange(() => cb(undefined, undefined));
    return () => {
      u1();
      u2();
    };
  }

  /** Set or replace a source handle. Throws if the URL is malformed. */
  setSource(name: string, handle: HandleInput): void {
    const url = toHandleUrl(handle);
    assertValidHandleUrl(url);
    this.doc.change((d) => {
      d.source[name] = url;
    });
  }

  /** Remove a source handle by name. */
  removeSource(name: string): void {
    this.doc.change((d) => {
      delete d.source[name];
    });
  }

  /** Set or replace a target handle. Throws if the URL is malformed. */
  setTarget(name: string, handle: HandleInput): void {
    const url = toHandleUrl(handle);
    assertValidHandleUrl(url);
    this.doc.change((d) => {
      d.target[name] = url;
    });
  }

  /** Remove a target handle by name. */
  removeTarget(name: string): void {
    this.doc.change((d) => {
      delete d.target[name];
    });
  }

  // ── persistence ─────────────────────────────────────────────────────────

  persisted(): boolean {
    return this.#persisted;
  }

  /**
   * Flip the persistence flag on the doc. Updates `persisted()` synchronously
   * so the caller can rely on it immediately; the doc write happens in the
   * same tick. Turning persistence on writes the current in-memory value to
   * the doc; turning it off removes the cached value.
   */
  setPersisted(on: boolean): void {
    if (this.#persisted === on) return;
    this.#persisted = on;
    const v = this.#value;
    this.doc.change((d) => {
      if (on) {
        d.persist = true;
        if (v !== undefined) (d as { value?: unknown }).value = v;
      } else {
        delete d.persist;
        delete (d as { value?: unknown }).value;
      }
    });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Explicit teardown. Idempotent. Use this when you want deterministic
   * cleanup (tests, hot reloads); in production normal GC plus the
   * FinalizationRegistry handle teardown without you doing anything.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const unsub of this.#sourceUnsubs.values()) unsub();
    this.#sourceUnsubs.clear();
    this.#docUnsub?.();
    this.#docUnsub = null;
    resolvedByRepo.get(this.repo)?.delete(this.url);
  }

  // ── internals ──────────────────────────────────────────────────────────

  async #refreshEndpoints(): Promise<void> {
    if (this.#destroyed) return;
    const myGen = ++this.#refreshGen;

    let next: EdgeHandleDoc | undefined;
    try {
      next = this.doc.doc();
    } catch {
      return;
    }
    if (!next) return;

    // Sync persistence + value from the doc. Use structural equality so we
    // don't notify on every refresh for object-valued edges (each automerge
    // snapshot hands back a fresh view, reference-unequal to our cached one).
    const docPersist = next.persist === true;
    if (docPersist) {
      this.#persisted = true;
      const docValue = ("value" in next ? next.value : undefined) as
        | TValue
        | undefined;
      if (!valuesEqual(docValue, this.#value)) {
        this.#value = docValue;
        this.#valueSubscribers.notify(this.#value);
      }
    } else if (this.#persisted) {
      this.#persisted = false;
    }

    // Members: skip the rest if neither map changed AND we have no
    // outstanding resolution errors (errors should be retried on the next
    // doc tick — a peer that wasn't loaded before might be now).
    const sourceUrls = next.source ?? {};
    const targetUrls = next.target ?? {};
    const sourceJson = JSON.stringify(sourceUrls);
    const targetJson = JSON.stringify(targetUrls);
    const hadErrors =
      Object.keys(this.sourceErrors).length > 0 ||
      Object.keys(this.targetErrors).length > 0;
    if (
      !hadErrors &&
      sourceJson === this.#lastSourceJson &&
      targetJson === this.#lastTargetJson
    ) {
      return;
    }

    const [sourceResolved, targetResolved] = await Promise.all([
      resolveMap(this.repo, sourceUrls, this.#initVisited),
      resolveMap(this.repo, targetUrls, this.#initVisited),
    ]);
    if (this.#destroyed || myGen !== this.#refreshGen) return;

    const stillErrored =
      Object.keys(sourceResolved.errors).length > 0 ||
      Object.keys(targetResolved.errors).length > 0;

    // Cache the snapshot only when resolution fully succeeded. Leaving the
    // cache stale on errors means the next doc tick will retry.
    if (stillErrored) {
      this.#lastSourceJson = "";
      this.#lastTargetJson = "";
    } else {
      this.#lastSourceJson = sourceJson;
      this.#lastTargetJson = targetJson;
    }

    for (const unsub of this.#sourceUnsubs.values()) unsub();
    this.#sourceUnsubs.clear();

    this.source = sourceResolved.endpoints;
    this.target = targetResolved.endpoints;
    this.sourceErrors = sourceResolved.errors;
    // Fan-out errors are reset on each refresh; subsequent writes will
    // populate fresh ones if they fail.
    this.targetErrors = targetResolved.errors;

    // Per-source emission subscriptions. Listener closure captures a WeakRef
    // to self so the subscription doesn't pin this edge.
    const self = this.#self;
    for (const [name, handle] of Object.entries(this.source)) {
      const cb = (value: unknown) => {
        const e = self.deref();
        if (e) e.#sourceSubscribers.notify({ value, key: name });
      };
      const unsub = handle.onChange(cb);
      this.#sourceUnsubs.set(name, unsub);
    }

    this.#membersSubscribers.notify();
  }

  #fanOut(value: TValue | undefined): void {
    const writeErrors: Record<string, Error> = {};
    for (const [name, handle] of Object.entries(this.target)) {
      try {
        handle.change(value as never);
      } catch (err) {
        writeErrors[name] = err as Error;
        console.error(
          `[edge-handles] write to target.${name} (${handle.url}) failed`,
          err
        );
      }
    }
    // Update targetErrors per-name: replace fan-out errors for the iterated
    // names (success clears stale errors, failure sets fresh ones). Errors
    // for names that aren't in `target` (i.e. resolution failures) are
    // preserved.
    if (Object.keys(this.target).length > 0) {
      const next = { ...this.targetErrors };
      for (const name of Object.keys(this.target)) {
        if (writeErrors[name]) next[name] = writeErrors[name];
        else delete next[name];
      }
      this.targetErrors = next;
    }
  }
}

// ─── value equality ────────────────────────────────────────────────────────

/**
 * Equality for cached values. Fast path for primitives via `Object.is`; for
 * objects we fall back to JSON.stringify, which is good enough for the
 * value shapes we expect (Automerge primitives + plain JSON-ish objects).
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ─── url resolution ────────────────────────────────────────────────────────

/**
 * Resolve a URL to a live `Handle`. Returns the handle on success or an
 * `Error` describing the failure. The `visited` set breaks cycles in chains
 * of edges.
 */
async function resolveHandleUrl(
  repo: Repo,
  url: HandleUrl,
  visited: Set<string>
): Promise<Handle | Error> {
  const kind = classifyHandleUrl(url);
  if (kind === "invalid") return new Error(`invalid handle URL: ${url}`);

  if (kind === "ref") {
    // A path URL (`automerge:<docId>/<path>`) resolves to a scoped sub-handle:
    // `repo.find` applies the path suffix and hands back a `DocHandle` whose
    // reads/writes are scoped to that sub-tree (the old `Ref`).
    try {
      const handle = await repo.find(url as AutomergeUrl);
      return new DocHandleEndpoint(handle);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  let documentId;
  try {
    ({ documentId } = parseAutomergeUrl(url as AutomergeUrl));
  } catch (err) {
    return err instanceof Error
      ? err
      : new Error(`could not parse URL: ${url}`);
  }

  let handle: DocHandle<unknown>;
  try {
    handle = (await repo.find(documentId)) as DocHandle<unknown>;
  } catch (err) {
    return err instanceof Error
      ? err
      : new Error(`repo.find failed for ${url}`);
  }

  let doc: { "@patchwork"?: { type?: string } } | undefined;
  try {
    doc = handle.doc() as { "@patchwork"?: { type?: string } } | undefined;
  } catch {
    return new Error(`doc unavailable for ${url}`);
  }

  if (doc?.["@patchwork"]?.type === EDGE_HANDLE_DATATYPE) {
    if (visited.has(handle.url)) {
      return new Error(`cycle through edge ${handle.url}`);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(handle.url);
    try {
      return await openEdgeHandle(repo, handle.url, nextVisited);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  // A plain doc URL: the `DocHandle` itself is the endpoint (no sub-path).
  return new DocHandleEndpoint(handle);
}

interface ResolveMapResult {
  endpoints: Record<string, Handle>;
  errors: Record<string, Error>;
}

async function resolveMap(
  repo: Repo,
  urls: { [name: string]: HandleUrl },
  initVisited: Set<string>
): Promise<ResolveMapResult> {
  const entries = Object.entries(urls);
  if (entries.length === 0) return { endpoints: {}, errors: {} };
  const resolved = await Promise.all(
    entries.map(async ([name, url]) => {
      const result = await resolveHandleUrl(repo, url, new Set(initVisited));
      return { name, result };
    })
  );
  const endpoints: Record<string, Handle> = {};
  const errors: Record<string, Error> = {};
  for (const { name, result } of resolved) {
    if (result instanceof Error) errors[name] = result;
    else endpoints[name] = result;
  }
  return { endpoints, errors };
}

// ─── factory + cache ───────────────────────────────────────────────────────

/**
 * In-flight cache: concurrent opens of the same `(repo, url)` share the
 * same promise so referential equality holds across races.
 */
const pendingByRepo = new WeakMap<
  Repo,
  Map<string, Promise<EdgeHandle<any>>>
>();

/**
 * Resolved cache: settled instances, held by `WeakRef` so we don't pin
 * them when no caller holds a strong reference. Dead entries are pruned by
 * the FinalizationRegistry on top of this file.
 */
const resolvedByRepo = new WeakMap<
  Repo,
  Map<string, WeakRef<EdgeHandle<any>>>
>();

function getPending(repo: Repo): Map<string, Promise<EdgeHandle<any>>> {
  let m = pendingByRepo.get(repo);
  if (!m) {
    m = new Map();
    pendingByRepo.set(repo, m);
  }
  return m;
}

function getResolved(repo: Repo): Map<string, WeakRef<EdgeHandle<any>>> {
  let m = resolvedByRepo.get(repo);
  if (!m) {
    m = new Map();
    resolvedByRepo.set(repo, m);
  }
  return m;
}

/** Initial values for a freshly created EdgeHandle doc. */
export interface CreateEdgeHandleInit<TValue = unknown> {
  source?: { [name: string]: HandleInput };
  target?: { [name: string]: HandleInput };
  /** Enable persisting the value to the doc (mirrors every `change()`). */
  persist?: boolean;
  /** Initial value; only written to the doc when `persist` is true. */
  value?: TValue;
}

/** Create a fresh `EdgeHandleDoc` in the repo and return a live `EdgeHandle`. */
export async function createEdgeHandle<T = unknown>(
  repo: Repo,
  init: CreateEdgeHandleInit<T> = {}
): Promise<EdgeHandle<T>> {
  const sourceUrls: Record<string, HandleUrl> = {};
  for (const [name, h] of Object.entries(init.source ?? {})) {
    const url = toHandleUrl(h);
    assertValidHandleUrl(url);
    sourceUrls[name] = url;
  }
  const targetUrls: Record<string, HandleUrl> = {};
  for (const [name, h] of Object.entries(init.target ?? {})) {
    const url = toHandleUrl(h);
    assertValidHandleUrl(url);
    targetUrls[name] = url;
  }

  const initial: EdgeHandleDoc = {
    "@patchwork": { type: EDGE_HANDLE_DATATYPE, version: 1 },
    source: sourceUrls,
    target: targetUrls,
  };
  if (init.persist) {
    initial.persist = true;
    if (init.value !== undefined) initial.value = init.value;
  }

  const handle = repo.create<EdgeHandleDoc>(initial);
  await handle.whenReady();
  return openForDoc<T>(repo, handle, new Set());
}

/**
 * Find an existing `EdgeHandle` by URL. Returns the cached instance for
 * `(repo, url)` if one is still live; otherwise opens a fresh one. Throws
 * if the URL does not point at an edge-handle doc.
 *
 * In-flight promises are deduplicated, so concurrent calls all await the
 * same resolution.
 */
export async function findEdgeHandle<T = unknown>(
  repo: Repo,
  url: AutomergeUrl
): Promise<EdgeHandle<T>> {
  return openEdgeHandle<T>(repo, url, new Set());
}

/** Internal open used by both the public `findEdgeHandle` and chained-edge
 *  resolution. The `visited` set propagates cycle detection. */
async function openEdgeHandle<T = unknown>(
  repo: Repo,
  url: AutomergeUrl,
  visited: Set<string>
): Promise<EdgeHandle<T>> {
  const pending = getPending(repo);
  const existingPromise = pending.get(url);
  if (existingPromise) return existingPromise as Promise<EdgeHandle<T>>;

  const live = getResolved(repo).get(url)?.deref();
  if (live) return live as EdgeHandle<T>;

  const promise = (async () => {
    const { documentId } = parseAutomergeUrl(url);
    const handle = await repo.find<EdgeHandleDoc>(documentId);
    await handle.whenReady();
    let doc: { "@patchwork"?: { type?: string } } | undefined;
    try {
      doc = handle.doc();
    } catch {
      throw new Error(`findEdgeHandle: ${url} is unavailable`);
    }
    if (doc?.["@patchwork"]?.type !== EDGE_HANDLE_DATATYPE) {
      throw new Error(
        `findEdgeHandle: ${url} is not an edge-handle doc (type=${doc?.["@patchwork"]?.type})`
      );
    }
    return openForDoc<T>(repo, handle, visited);
  })();

  pending.set(url, promise);
  promise.then(
    (edge) => {
      pending.delete(url);
      getResolved(repo).set(url, new WeakRef(edge));
    },
    () => {
      pending.delete(url);
    }
  );
  return promise;
}

async function openForDoc<T>(
  repo: Repo,
  handle: DocHandle<EdgeHandleDoc>,
  visited: Set<string>
): Promise<EdgeHandle<T>> {
  const resolved = getResolved(repo);
  const live = resolved.get(handle.url)?.deref();
  if (live) return live as EdgeHandle<T>;

  const edge = new EdgeHandle<T>(repo, handle, { visited });
  resolved.set(handle.url, new WeakRef(edge));
  await edge._init();
  return edge;
}
