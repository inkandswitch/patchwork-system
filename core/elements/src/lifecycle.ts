/**
 * Mount-lifecycle plumbing shared by component mode (`<patchwork-view>`) and
 * legacy mode (`LegacyImpl`).
 */

type Cleanup = () => unknown;

/** Cleanups registered while a view is mounted, run in order on teardown. */
export class Teardowns {
  readonly #cleanups = new Set<Cleanup>();

  add(cleanup: Cleanup): void {
    this.#cleanups.add(cleanup);
  }

  /** Runs and forgets every registered cleanup, awaiting each in turn. */
  async run(): Promise<void> {
    const cleanups = [...this.#cleanups];
    this.#cleanups.clear();
    for (const cleanup of cleanups) await cleanup();
  }
}

/**
 * An async task that runs at most once at a time: calls made while it is in
 * flight share that run instead of starting another. Used for teardown, so
 * two attributes changing in one tick (or a disconnect racing an attribute
 * change) don't double-run the same cleanups.
 */
export class Serialized {
  readonly #task: () => Promise<void>;
  #inFlight: Promise<void> | null = null;

  constructor(task: () => Promise<void>) {
    this.#task = task;
  }

  /** The run in flight, if any. Cleared before callers chained on it resume. */
  get pending(): Promise<void> | null {
    return this.#inFlight;
  }

  run(): Promise<void> {
    this.#inFlight ??= this.#runOnce();
    return this.#inFlight;
  }

  async #runOnce(): Promise<void> {
    try {
      await this.#task();
    } finally {
      this.#inFlight = null;
    }
  }
}

/**
 * Dispatches `event` from `element`, or, once `element` is detached (where
 * bubbling goes nowhere), from the closest ancestor along the parent chain it
 * was last connected under that is still connected.
 */
export function dispatchFromNearestConnected(
  element: Element,
  lastParent: Element | null,
  event: Event
): void {
  if (element.isConnected) {
    element.dispatchEvent(event);
    return;
  }
  let node = lastParent;
  while (node && !node.isConnected) node = node.parentElement;
  node?.dispatchEvent(event);
}
