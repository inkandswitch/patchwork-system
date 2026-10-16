// The control protocol every patchwork SharedWorker speaks with its tabs:
// console forwarding, a debug toggle, and a build handshake that restarts the
// worker when a tab from a newer build connects. Everything else is the
// worker's own business and arrives through `onMessage`.

import { buildId, isNewerBuild } from "./build-id.js";

const MAX_BUFFER = 200;
// How long a restart waits on `onRestart` before closing regardless.
const RESTART_DRAIN_MS = 5_000;

/**
 * Worker → every tab: this instance is shutting down to be replaced. `build`
 * is the build that asked for it (a tab's, when newer than `from`, this
 * worker's own), so a tab can tell whether it's the stale party.
 */
export type RestartingMessage = {
  type: "restarting";
  reason: string;
  build?: number;
  from?: number;
};

/**
 * Worker → every tab: the very last message before `self.close()`. Chromium
 * doesn't fire `close` on a tab's port when a SharedWorker closes itself, so
 * this is the tab's cue to drop its port and spawn the replacement. By the
 * time it arrives the global's closing flag is set, so the next
 * `new SharedWorker()` gets a fresh instance rather than attaching to this one.
 */
export type ClosingMessage = { type: "closing" };

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
    /**
     * Called once when the worker is about to close itself for a restart:
     * stop taking new work and flush what's in flight. Bounded by
     * RESTART_DRAIN_MS; the worker closes either way.
     */
    onRestart?: () => Promise<void> | void;
  } = {}
): { log: (...args: unknown[]) => void; restart: (reason: string) => void } {
  const ports = new Set<MessagePort>();
  let restarting: RestartingMessage | undefined;
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

  // A SharedWorker is keyed by url + name, so after a deploy a freshly loaded
  // tab attaches to whatever instance older tabs are keeping alive. Closing
  // ourselves is the only way to get the new script running: once the global's
  // closing flag is set, the next `new SharedWorker()` spawns a fresh one.
  const restart = (reason: string, build?: number) => {
    if (restarting) return;
    restarting = { type: "restarting", reason, build, from: buildId };
    console.warn(`[lifecycle] ${name} SharedWorker restarting: ${reason}`);
    for (const port of ports) postToPort(port, restarting);

    const drained = (async () => {
      await handlers.onRestart?.();
    })();
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, RESTART_DRAIN_MS)
    );
    Promise.race([drained, deadline])
      .catch((error) => console.error("restart drain failed", error))
      .finally(() => {
        console.warn(`[lifecycle] ${name} SharedWorker closing for restart`);
        const closing: ClosingMessage = { type: "closing" };
        for (const port of ports) postToPort(port, closing);
        self.close();
      });
  };

  self.addEventListener("connect", (event) => {
    const port = (event as MessageEvent).ports[0];
    handlers.onConnect?.(port);

    port.addEventListener("message", (messageEvent) => {
      const data = (messageEvent as MessageEvent).data;
      if (data?.type === "debug") {
        debugging = data.debug;
        return;
      }
      if (data?.type === "hello") {
        // Only a *newer* tab restarts us. An older tab (one that hasn't
        // reloaded yet) attaching to a newer worker is left alone, or the two
        // would take turns restarting each other.
        if (isNewerBuild(data.build)) {
          restart(
            `a tab from build ${data.build} connected (this is build ${buildId})`,
            data.build
          );
        }
        return;
      }
      if (data?.type === "restart") {
        restart(
          typeof data.reason === "string" ? data.reason : "asked by a tab"
        );
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
    // A tab that connected mid-drain still needs to hear it, or it would wait
    // on this instance until the port closes.
    if (restarting) postToPort(port, restarting);
  });

  console.warn(
    `[lifecycle] ${name} SharedWorker started` +
      (buildId === undefined ? "" : ` (build ${buildId})`)
  );

  return {
    log: (...args: unknown[]) => {
      if (debugging) console.log(`[${name}]`, ...args);
    },
    restart: (reason) => restart(reason),
  };
}
