/**
 * EdgeHandle: a doc-backed reactive cell with named source and target
 * connections to documents, sub-trees and other edges.
 *
 * The doc holds the wiring (`source` and `target`, and the value when it's
 * persisted); the class is its live presence. An edge computes nothing
 * itself: a transform subscribes to `onSourceChange` and `onMembersChange`
 * (or `onAnyChange`) and writes back through `change`.
 *
 *     edge.value() / edge.change(fnOrValue) / edge.onValueChange(cb)
 *     edge.source / edge.target                 // resolved handles
 *     edge.sourceErrors / edge.targetErrors     // errors by name
 *     edge.onSourceChange(cb)                   // (value, key), per source
 *     edge.onMembersChange(cb)                  // (), wiring changed; fires on subscribe
 *     edge.onAnyChange(cb)                      // either, (value?, key?)
 *     edge.setSource(name, handle) / removeSource(name)
 *     edge.setTarget(name, handle) / removeTarget(name)
 *     edge.persisted() / edge.setPersisted(on)
 *     edge.destroy()
 *
 * Nothing needs destroying in normal use: an edge nobody holds is collected,
 * and a FinalizationRegistry takes down its listeners.
 */

import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type SubChangeFn,
} from "@automerge/automerge-repo/slim";

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

/** `@patchwork.type` value used by EdgeHandle docs. */
export const EDGE_HANDLE_DATATYPE = "edge-handle";

/**
 * A handle's url: `automerge:<docId>` for a whole doc or edge,
 * `automerge:<docId>/<path>` for a sub-tree.
 */
export type HandleUrl = AutomergeUrl;

/** What an EdgeHandle doc holds. */
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
 * A `DocHandle`, whole doc or `.sub()` sub-tree, as a {@link Handle}. Reads,
 * writes and `change` events are all scoped to its path.
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

function isValidHandleUrl(url: string): boolean {
  const kind = classifyHandleUrl(url);
  if (kind === "invalid") return false;
  // Only the documentId part has a canonical check.
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
 * Anything that can be an endpoint: a {@link Handle}, a `DocHandle` or
 * sub-handle (by its `url`), or a {@link HandleUrl}.
 */
export type HandleInput = Handle | DocHandle<unknown> | HandleUrl;

function toHandleUrl(h: HandleInput): HandleUrl {
  return typeof h === "string" ? h : (h.url as HandleUrl);
}

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
    // Drop the dead WeakRef from the cache.
    const cache = resolvedByRepo.get(repo);
    if (cache && cache.get(url)?.deref() === undefined) {
      cache.delete(url);
    }
  }
);

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
   * Errors by target name, from resolving it or from writing to it. Either
   * kind clears when a later resolve or write succeeds.
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

    // Through a WeakRef: the DocHandle lives as long as the Repo, and would
    // otherwise keep the edge alive.
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

  value(): TValue | undefined {
    return this.#value;
  }

  /**
   * Set the value, or change it with `(prev) => next`, where returning
   * nothing keeps it. Writes it to the doc when persisted, and to every
   * target, `undefined` too (what a target makes of a clear is its business).
   * A `change` made while one is fanning out (a cycle) is dropped.
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

  /**
   * Fires when a source's value emits, with `(value, key)`; unlike
   * {@link onAnyChange}, `key` is always set. Doesn't fire when you
   * subscribe, or when the wiring changes: see {@link onMembersChange}.
   */
  onSourceChange(cb: (value: unknown, key: string) => void): () => void {
    return this.#sourceSubscribers.add(({ value, key }) => cb(value, key));
  }

  /**
   * Fires when you subscribe and whenever the wiring changes, with the new
   * wiring already on `edge.source` and `edge.target`. A transform that
   * recomputes on any upstream change wants this and {@link onSourceChange}
   * together, which is {@link onAnyChange}.
   */
  onMembersChange(cb: () => void): () => void {
    const unsub = this.#membersSubscribers.add(cb);
    cb();
    return unsub;
  }

  /**
   * {@link onSourceChange} and {@link onMembersChange} in one: `cb(value, key)`
   * when a source emits, `cb(undefined, undefined)` when you subscribe and
   * when the wiring changes.
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

  persisted(): boolean {
    return this.#persisted;
  }

  /**
   * Turn persistence on or off. `persisted()` and the doc both change straight
   * away. Turning it on writes the current value to the doc; turning it off
   * removes it.
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

  /**
   * Tear down now. Idempotent. For when cleanup has to be deterministic
   * (tests, hot reloads); otherwise GC and the FinalizationRegistry do it.
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

    // Compared structurally: every automerge snapshot is a fresh object, so
    // an object value would otherwise notify on every refresh.
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

    // Nothing to do if the wiring hasn't changed, unless something failed to
    // resolve: a doc that wasn't loaded before might be now.
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

    // Only remembered when everything resolved, so a failure is retried.
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
    // Write errors go here; the next failing write sets them again.
    this.targetErrors = targetResolved.errors;

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
    // A write replaces only the errors of the targets it wrote to; resolution
    // errors for targets that aren't wired stay.
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

/** `Object.is`, then JSON for objects: enough for automerge values and plain JSON. */
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

/** A live Handle for `url`, or the Error that stopped it. `visited` breaks cycles through edges. */
async function resolveHandleUrl(
  repo: Repo,
  url: HandleUrl,
  visited: Set<string>
): Promise<Handle | Error> {
  const kind = classifyHandleUrl(url);
  if (kind === "invalid") return new Error(`invalid handle URL: ${url}`);

  if (kind === "ref") {
    // A path url: `repo.find` gives a sub-handle scoped to that sub-tree.
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

/** Concurrent opens of the same `(repo, url)` share one promise, so they get the same edge. */
const pendingByRepo = new WeakMap<
  Repo,
  Map<string, Promise<EdgeHandle<any>>>
>();

/**
 * Settled edges, by WeakRef so the cache doesn't keep them alive. The
 * FinalizationRegistry above prunes the dead ones.
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
 * Find an `EdgeHandle` by url: the live instance for `(repo, url)` if there
 * is one, or a fresh one. Concurrent calls share one open. Throws if the url
 * isn't an edge-handle doc.
 */
export async function findEdgeHandle<T = unknown>(
  repo: Repo,
  url: AutomergeUrl
): Promise<EdgeHandle<T>> {
  return openEdgeHandle<T>(repo, url, new Set());
}

/** Shared by `findEdgeHandle` and chained edges; `visited` carries cycle detection. */
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
