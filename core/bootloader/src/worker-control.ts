// The control protocol every patchwork SharedWorker speaks with its tabs:
// console forwarding, a `hello` on connect, ping/pong for the tab's death
// detection, and a debug toggle. Everything else is the worker's own business
// and arrives through `onMessage`.

/** A fresh instance means cold in-memory state, so tabs watch this. */
export const WORKER_INSTANCE_ID = Math.random().toString(36).slice(2);
export const WORKER_BOOT_TIME = Date.now();

const MAX_BUFFER = 200;

export type WorkerControl = {
  log: (...args: unknown[]) => void;
  debugging: () => boolean;
  post: (port: MessagePort, message: unknown) => void;
  ports: Set<MessagePort>;
};

export function postToPort(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn("sending failed", error);
  }
}

function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function startWorkerControl(
  name: string,
  handlers: {
    onConnect?: (port: MessagePort) => void;
    onMessage?: (data: any, port: MessagePort, event: MessageEvent) => void;
    onClose?: (port: MessagePort) => void;
  } = {}
): WorkerControl {
  const ports = new Set<MessagePort>();
  // Logs emitted before any tab connects (wasm boot) would otherwise be lost.
  const preConnect: Array<{ level: string; args: string[] }> = [];
  // `debug` reads localStorage, which a SharedWorker doesn't have, so this is
  // toggled by a control message from a tab instead.
  let debugging = false;

  // A SharedWorker's own console is buried in chrome://inspect, so mirror
  // everything over each connected tab's control port.
  const forward = (level: string, rawArgs: unknown[]) => {
    const args = rawArgs.map(serializeArg);
    if (!ports.size) {
      if (preConnect.length < MAX_BUFFER) preConnect.push({ level, args });
      return;
    }
    for (const port of ports)
      postToPort(port, { type: "console", level, args });
  };

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      forward(level, args);
    };
  }

  self.addEventListener("error", (event) => {
    const e = event as ErrorEvent;
    forward("error", [
      `uncaught error: ${e.message}`,
      e.error instanceof Error ? e.error.stack : undefined,
    ]);
  });

  self.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    forward("error", [
      "unhandled rejection:",
      reason instanceof Error ? reason.stack || reason.message : reason,
    ]);
  });

  self.addEventListener("connect", (event) => {
    const port = (event as MessageEvent).ports[0];
    handlers.onConnect?.(port);

    port.addEventListener("message", (messageEvent) => {
      const data = (messageEvent as MessageEvent).data;
      if (data?.type === "ping") {
        postToPort(port, {
          type: "pong",
          id: data.id,
          instanceId: WORKER_INSTANCE_ID,
        });
        return;
      }
      if (data?.type === "debug") {
        debugging = data.debug;
        return;
      }
      handlers.onMessage?.(data, port, messageEvent as MessageEvent);
    });

    // Fires when the owning page is destroyed.
    port.addEventListener("close", () => {
      ports.delete(port);
      handlers.onClose?.(port);
    });

    port.start();
    postToPort(port, {
      type: "hello",
      instanceId: WORKER_INSTANCE_ID,
      bootTime: WORKER_BOOT_TIME,
    });

    ports.add(port);
    for (const { level, args } of preConnect.splice(0)) {
      postToPort(port, { type: "console", level, args });
    }
  });

  console.warn(
    `[lifecycle] ${name} SharedWorker started (instance ${WORKER_INSTANCE_ID})`
  );

  return {
    ports,
    post: postToPort,
    debugging: () => debugging,
    log: (...args: unknown[]) => {
      if (debugging) console.log(`[${name}]`, ...args);
    },
  };
}
