import debug from "debug";

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
};

/**
 * A SharedWorker a tab keeps alive: spawned on demand, and respawned if the
 * browser terminates it (which it may, under memory pressure).
 */
export function sharedWorkerHandle(
  name: string,
  /** Read on every spawn, so a site can set the path after this is built. */
  path: () => string,
  {
    debugging,
    onMessage,
    onSpawn,
  }: {
    debugging: boolean;
    onMessage: (event: MessageEvent) => void;
    onSpawn?: (worker: SharedWorker) => void;
  }
): SharedWorkerHandle {
  let current: SharedWorker | undefined;

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
    worker.port.addEventListener("message", onMessage);
    worker.port.postMessage({ type: "debug", debug: debugging });

    onSpawn?.(worker);
    return worker;
  };

  return {
    name,
    get,
    post(message, transfer) {
      get().port.postMessage(message, transfer ?? []);
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
