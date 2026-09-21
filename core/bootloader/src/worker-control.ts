// The control protocol every patchwork SharedWorker speaks with its tabs:
// console forwarding and a debug toggle. Everything else is the worker's own
// business and arrives through `onMessage`.

const MAX_BUFFER = 200;

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
): { log: (...args: unknown[]) => void } {
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
    ports.add(port);
    for (const { level, args } of preConnect.splice(0)) {
      postToPort(port, { type: "console", level, args });
    }
  });

  console.warn(`[lifecycle] ${name} SharedWorker started`);

  return {
    log: (...args: unknown[]) => {
      if (debugging) console.log(`[${name}]`, ...args);
    },
  };
}
