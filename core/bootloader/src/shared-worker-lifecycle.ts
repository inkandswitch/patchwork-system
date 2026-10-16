import debug from "debug";
import { buildId } from "./build-id.js";
import type { ClosingMessage, RestartingMessage } from "./worker-control.js";

export const lifecycleLog = debug("patchwork:lifecycle");

function describeErrorEvent(event: Event): string {
  const error = event as ErrorEvent;
  const where = error.filename
    ? ` (${error.filename}:${error.lineno}:${error.colno})`
    : "";
  return `${error.message || String(event)}${where}`;
}

export type SharedWorkerHandle = {
  readonly name: string;
  /** The current instance, spawning one if there isn't a live one. */
  get(): SharedWorker;
  /** Send on the current instance's control port. */
  post(message: unknown, transfer?: Transferable[]): void;
  /** Ask the current instance to close itself; the next use spawns a fresh one. */
  restart(reason: string): void;
};

/**
 * A SharedWorker a tab keeps alive: spawned on demand, and respawned if the
 * browser terminates it (which it may, under memory pressure) or it restarts
 * itself because a tab from a newer build connected.
 *
 * Browser termination shows up as `close` on the control port. A self-restart
 * doesn't (Chromium never fires it for a worker that called `self.close()`),
 * so the worker announces it instead: `restarting` when it decides to, and
 * `closing` as its last word, which is when the replacement is spawned.
 */
export function sharedWorkerHandle(
  name: string,
  /** Read on every spawn, so a site can set the path after this is built. */
  path: () => string,
  {
    debugging,
    onMessage,
    onSpawn,
    onRestarting,
  }: {
    debugging: boolean;
    onMessage: (event: MessageEvent) => void;
    onSpawn?: (worker: SharedWorker) => void;
    /** The worker announced it's closing to be replaced. */
    onRestarting?: (message: RestartingMessage) => void;
  }
): SharedWorkerHandle {
  let current: SharedWorker | undefined;
  // Between the current instance's `restarting` and its `closing`, posts
  // would go to a worker that's winding down; hold them for the replacement.
  let held: Array<[unknown, Transferable[]]> | undefined;

  const replace = (worker: SharedWorker) => {
    if (current !== worker) return;
    worker.port.close();
    current = undefined;
    // The service worker needs a resolver to exist, so respawn now rather
    // than on the next post().
    const next = get();
    const queued = held ?? [];
    held = undefined;
    for (const [message, transfer] of queued)
      next.port.postMessage(message, transfer);
  };

  const get = (): SharedWorker => {
    if (current) return current;

    const worker = new SharedWorker(path(), { name, type: "module" });
    current = worker;

    // Fires when a message can't be structured-deserialized. Silent otherwise:
    // the message is dropped, which looks identical to a worker that never
    // replied.
    worker.port.addEventListener("messageerror", (event) => {
      console.error(`[${name}] undeserializable message from worker:`, event);
    });
    // Not gated on the debug namespace: a worker that fails to load never
    // replies to anything, and this is the only signal that says so.
    worker.addEventListener("error", (event) => {
      console.error(`${name} SharedWorker error:`, describeErrorEvent(event));
    });
    // Fires when the worker is terminated. Drop it so the next get() spawns a
    // replacement.
    worker.port.addEventListener("close", () => {
      if (current !== worker) return;
      lifecycleLog("%s SharedWorker control port closed", name);
      current = undefined;
    });
    // Replies come back on this port, and we listen with addEventListener
    // rather than onmessage, so it needs start().
    worker.port.start();
    worker.port.addEventListener("message", (event) => {
      const type = event.data?.type;
      if (type === "restarting") {
        const message = event.data as RestartingMessage;
        lifecycleLog("%s SharedWorker restarting: %s", name, message.reason);
        if (current === worker) held ??= [];
        onRestarting?.(message);
        return;
      }
      if (type === "closing") {
        lifecycleLog("%s SharedWorker closed itself, respawning", name);
        replace(worker);
        return;
      }
      onMessage(event);
    });
    worker.port.postMessage({ type: "debug", debug: debugging });
    // The worker compares this against its own build and restarts if we're
    // newer — see startWorkerControl.
    worker.port.postMessage({ type: "hello", build: buildId });

    onSpawn?.(worker);
    return worker;
  };

  return {
    name,
    get,
    post(message, transfer) {
      if (held) held.push([message, transfer ?? []]);
      else get().port.postMessage(message, transfer ?? []);
    },
    restart(reason) {
      // Only an instance that exists can be restarted; spawning one to kill
      // it would be pointless.
      current?.port.postMessage({ type: "restart", reason });
    },
  };
}

/**
 * Mirror a worker's forwarded console output into this tab's console, since a
 * SharedWorker's own console is only visible in chrome://inspect.
 */
export function forwardWorkerConsole(name: string, data: any): boolean {
  if (data?.type !== "console") return false;
  const { level, args } = data;
  if (
    !lifecycleLog.enabled &&
    typeof args?.[0] === "string" &&
    args[0].includes("[lifecycle]")
  ) {
    return true;
  }
  const write = (console as any)[level] ?? console.log;
  // The worker's logs carry %c directives in args[0] with CSS in the following
  // args, so the tag has to go inside the format string or the CSS prints raw.
  if (typeof args[0] === "string") {
    write(`[${name}] ${args[0]}`, ...args.slice(1));
  } else {
    write(`[${name}]`, ...args);
  }
  return true;
}
