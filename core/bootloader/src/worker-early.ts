// What a SharedWorker's script does before it imports the rest of itself.
//
// A module's body only runs once its whole static import graph has been
// fetched and evaluated, which for the automerge worker is most of a megabyte
// and takes from half a second to several. Until it asks for its lock, nothing
// can tell it exists: the service worker, finding no lock, asks the tabs to
// start a worker. So a worker's script is a small module that does this, then
// imports the rest; startWorkerControl picks it up from there.
//
// Handed over through the global rather than a module, so it survives the two
// halves being bundled separately (the dev server bundles each worker on its
// own).

const EARLY = Symbol.for("@patchwork/worker-early");

export type EarlyStart = {
  lock: string | undefined;
  /** Resolves once this instance holds `lock` (straight away without one). */
  holding: Promise<void>;
  /** Stop buffering connections, and return the ones made so far. */
  take(): MessageEvent[];
};

/**
 * Ask for `lock` and hold on to every tab that connects. A SharedWorker's
 * `connect` events go nowhere without a listener, and tabs connect while the
 * rest of the worker is still loading.
 */
export function startEarly(lock?: string): EarlyStart {
  const connections: MessageEvent[] = [];
  const buffer = (event: Event) => connections.push(event as MessageEvent);
  self.addEventListener("connect", buffer);

  const holding =
    lock && self.navigator?.locks
      ? new Promise<void>((resolve) => {
          void navigator.locks.request(lock, () => {
            resolve();
            // Held until this global goes.
            return new Promise<never>(() => {});
          });
        })
      : Promise.resolve();

  const early: EarlyStart = {
    lock,
    holding,
    take() {
      self.removeEventListener("connect", buffer);
      return connections.splice(0);
    },
  };
  (globalThis as any)[EARLY] = early;
  return early;
}

/** What {@link startEarly} started, if this worker's script called it. */
export function takeEarly(): EarlyStart | undefined {
  const early = (globalThis as any)[EARLY] as EarlyStart | undefined;
  delete (globalThis as any)[EARLY];
  return early;
}

/**
 * Import the rest of the worker. If it doesn't load there's nothing here to
 * run it, but this instance holds the lock, so it closes and the tabs start
 * another; after a pause, so one that can't load doesn't spin.
 */
export async function importRest(
  early: EarlyStart,
  name: string,
  url: string
): Promise<void> {
  try {
    await import(/* @vite-ignore */ url);
  } catch (error) {
    const message = `${name} SharedWorker failed to load ${url}, closing`;
    console.error(message, error);
    const args = [
      message,
      error instanceof Error ? error.stack || error.message : String(error),
    ];
    setTimeout(() => {
      // The tabs show forwarded console messages, and `closing` is their cue
      // to start a replacement (see ClosingMessage); nothing else here can.
      for (const event of early.take()) {
        const port = event.ports[0];
        port?.postMessage({ type: "console", level: "error", args });
        port?.postMessage({ type: "closing" });
      }
      self.close();
    }, 1_000);
  }
}
