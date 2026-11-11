import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  isKeyhiveDoc,
  type PatchworkHive,
} from "@inkandswitch/patchwork-plugins";
import type { Teardowns } from "./lifecycle.js";

/**
 * Whether this device may open `docUrl`: it has been granted access, or the
 * doc is public. The worker that holds keyhive answers both (public docs are
 * read through patchwork's public pair, which it also holds).
 */
export function hasActiveAccess(
  hive: PatchworkHive,
  docUrl: AutomergeUrl
): Promise<boolean> {
  return hive.canRead(docUrl);
}

/** Called with the active identity's access after keyhive ingests remote ops. */
export type AccessListener = (hasAccess: boolean) => void;

/**
 * One `onChange` subscription per hive, fanned out to every watched doc. A
 * burst of changes (ops arrive in batches) is coalesced into one pass that
 * checks each watched doc's access once, however many views show it.
 */
class AccessWatcher {
  readonly #hive: PatchworkHive;
  readonly #listeners = new Map<AutomergeUrl, Set<AccessListener>>();
  #unsubscribe: (() => void) | undefined;
  #draining = false;
  #dirty = false;

  constructor(hive: PatchworkHive) {
    this.#hive = hive;
  }

  watch(url: AutomergeUrl, listener: AccessListener): () => void {
    let listeners = this.#listeners.get(url);
    if (!listeners) this.#listeners.set(url, (listeners = new Set()));
    listeners.add(listener);
    this.#unsubscribe ??= this.#hive.onChange(this.#onChange);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(url) === listeners) {
        this.#listeners.delete(url);
      }
      if (this.#listeners.size === 0) {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
      }
    };
  }

  #onChange = () => {
    this.#dirty = true;
    if (this.#draining) return;
    this.#draining = true;
    // A macrotask, so the whole synchronous-and-microtask burst lands first.
    setTimeout(() => void this.#drain(), 0);
  };

  // Changes that arrive mid-pass mark the watcher dirty and get one more pass.
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
      // Leave every view as it is; the next change checks again.
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

const watchers = new WeakMap<PatchworkHive, AccessWatcher>();

function watcherFor(hive: PatchworkHive): AccessWatcher {
  let watcher = watchers.get(hive);
  if (!watcher) watchers.set(hive, (watcher = new AccessWatcher(hive)));
  return watcher;
}

/**
 * Gates a mount on the active identity's access to `url`, and keeps watching
 * that access for as long as the mount lives: the watch is released by
 * `teardowns`, and every later access check is reported to `onChange`.
 *
 * Resolves true when the view may mount — there's no hive, `url` is a legacy
 * (zero-padded) doc keyhive doesn't govern, or access is granted. A failed
 * check counts as no access; the next change checks again.
 */
export async function gateOnAccess(
  hive: PatchworkHive | undefined,
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
