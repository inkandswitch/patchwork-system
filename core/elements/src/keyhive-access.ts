import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { isKeyhiveDoc } from "@inkandswitch/patchwork-plugins";
import type { Teardowns } from "./lifecycle.js";

type Access = Awaited<ReturnType<AutomergeRepoKeyhive["accessForDoc"]>>;

/** Whether a doc is readable through patchwork's public reader. */
export type PublicAccess = (docUrl: AutomergeUrl) => Promise<boolean>;

let publicAccess: PublicAccess | undefined;

/**
 * How to ask whether a doc is public. On ARK 0.8 a doc made public ("anyone
 * with the link") is granted to patchwork's public reader, not to whoever
 * opens it, and their own keyhive doesn't even hear about it: the server only
 * sends an identity the ops that concern it. So the reader, which fetches and
 * decrypts public docs for everyone, is asked. Setup gives this one.
 */
export function setPublicAccess(check: PublicAccess | undefined): void {
  publicAccess = check;
  publicAccessChanged();
}

/** The public reader learned something: check every watched doc again. */
export function publicAccessChanged(): void {
  for (const watcher of allWatchers) watcher.recheck();
}

/**
 * Whether the active identity may open `docUrl`: it's been granted access,
 * or the doc is public.
 *
 * A site built on ARK 0.6 (`keyhive.ark`) still has public access, and there
 * `accessForDoc` counts only what was granted to the identity directly. Its
 * `bestAccessForDoc` adds the public grant, so a public doc opens for
 * everyone. 0.8 has no public access of its own: {@link setPublicAccess}.
 */
export async function hasActiveAccess(
  hive: AutomergeRepoKeyhive,
  docUrl: AutomergeUrl
): Promise<boolean> {
  const id = hive.active.individual.id;
  const { bestAccessForDoc } = hive as {
    bestAccessForDoc?: (id: unknown, docUrl: AutomergeUrl) => Promise<Access>;
  };
  if (bestAccessForDoc) return !!(await bestAccessForDoc.call(hive, id, docUrl));
  if (await hive.accessForDoc(id, docUrl)) return true;
  return publicAccess ? publicAccess(docUrl).catch(() => false) : false;
}

/** Called with the active identity's access after keyhive ingests remote ops. */
export type AccessListener = (hasAccess: boolean) => void;

// The base class only types `networkAdapter` as far as `close` needs it; both
// ARK generations' adapters emit `ingest-remote` after ingesting remote ops.
type IngestEmitter = {
  on(event: "ingest-remote", listener: () => void): unknown;
  off(event: "ingest-remote", listener: () => void): unknown;
};

/**
 * One `ingest-remote` listener per hive, fanned out to every watched doc.
 * A burst of ops (they arrive in batches) is coalesced into one pass that
 * checks each watched doc's access once, however many views show it.
 */
class AccessWatcher {
  readonly #hive: AutomergeRepoKeyhive;
  readonly #emitter: IngestEmitter;
  readonly #listeners = new Map<AutomergeUrl, Set<AccessListener>>();
  #attached = false;
  #draining = false;
  #dirty = false;

  constructor(hive: AutomergeRepoKeyhive) {
    this.#hive = hive;
    this.#emitter = hive.networkAdapter as unknown as IngestEmitter;
  }

  watch(url: AutomergeUrl, listener: AccessListener): () => void {
    let listeners = this.#listeners.get(url);
    if (!listeners) this.#listeners.set(url, (listeners = new Set()));
    listeners.add(listener);
    if (!this.#attached) {
      this.#attached = true;
      this.#emitter.on("ingest-remote", this.#onIngest);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(url) === listeners) {
        this.#listeners.delete(url);
      }
      if (this.#listeners.size === 0 && this.#attached) {
        this.#attached = false;
        this.#emitter.off("ingest-remote", this.#onIngest);
      }
    };
  }

  /** Check every watched doc again, as if ops had come in. */
  recheck(): void {
    if (this.#listeners.size) this.#onIngest();
  }

  #onIngest = () => {
    this.#dirty = true;
    if (this.#draining) return;
    this.#draining = true;
    // A macrotask, so the whole synchronous-and-microtask burst lands first.
    setTimeout(() => void this.#drain(), 0);
  };

  // Ops that arrive mid-pass mark the watcher dirty and get one more pass.
  async #drain(): Promise<void> {
    try {
      while (this.#dirty) {
        this.#dirty = false;
        const urls = [...this.#listeners.keys()];
        await Promise.all(urls.map((url) => this.#check(url)));
      }
    } finally {
      this.#draining = false;
    }
  }

  async #check(url: AutomergeUrl): Promise<void> {
    let hasAccess: boolean;
    try {
      hasAccess = await hasActiveAccess(this.#hive, url);
    } catch {
      // Leave every view as it is; the next op checks again.
      return;
    }
    // Views that stopped watching during the check don't hear about it.
    const listeners = this.#listeners.get(url);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener(hasAccess);
    }
  }
}

const watchers = new WeakMap<AutomergeRepoKeyhive, AccessWatcher>();
// every watcher, for publicAccessChanged; there's one per hive, so a handful
const allWatchers = new Set<AccessWatcher>();

function watcherFor(hive: AutomergeRepoKeyhive): AccessWatcher {
  let watcher = watchers.get(hive);
  if (!watcher) {
    watchers.set(hive, (watcher = new AccessWatcher(hive)));
    allWatchers.add(watcher);
  }
  return watcher;
}

/**
 * Gates a mount on the active identity's access to `url`, and keeps watching
 * that access for as long as the mount lives: the watch is released by
 * `teardowns`, and every later access check is reported to `onChange`.
 *
 * Resolves true when the view may mount — there's no hive, `url` is a legacy
 * (padded-zero) doc keyhive doesn't govern, or access is granted. A failed
 * check counts as no access; the next op checks again.
 */
export async function gateOnAccess(
  hive: AutomergeRepoKeyhive | undefined,
  url: AutomergeUrl,
  teardowns: Teardowns,
  onChange: AccessListener
): Promise<boolean> {
  if (!hive || !isKeyhiveDoc(url)) return true;

  // Watch before the first check, so a grant that lands while it's in flight
  // isn't lost between a stale "no" and the subscription.
  let latestAccess: boolean | undefined;
  teardowns.add(
    watcherFor(hive).watch(url, (hasAccess) => {
      latestAccess = hasAccess;
      onChange(hasAccess);
    })
  );

  try {
    const access = await hasActiveAccess(hive, url);
    return latestAccess ?? access;
  } catch {
    return latestAccess ?? false;
  }
}
