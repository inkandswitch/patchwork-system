import debug from "debug";

export const lifecycleLog = debug("patchwork:lifecycle");

function describeErrorEvent(event: Event): string {
  const error = event as ErrorEvent;
  const where = error.filename
    ? ` (${error.filename}:${error.lineno}:${error.colno})`
    : "";
  return `${error.message || String(event)}${where}`;
}

// A silent port is not proof of death: the worker may still be evaluating its
// module graph, or be busy with wasm/sync work. In both cases every queued
// message is delivered once it catches up, and tearing the port down would lose
// them. So silence only starts a non-destructive probe: a second connection to
// the same instance. Only if the probe gets a `hello` while this port stays
// silent do we know the instance is alive but our port is stranded, and
// recover.
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 25_000;
// An idle worker hellos within milliseconds of connecting, so before first
// contact the budget is tighter — probing early rescues stranded boots fast.
const FIRST_CONTACT_TIMEOUT_MS = 4_000;
// After a slow boot both connections hello at roughly the same moment and
// cross-port delivery order isn't guaranteed, so give the suspect this long to
// also speak before concluding it's stranded.
const PROBE_GRACE_MS = 500;
// Below this spacing, skip: if the fresh worker is dead too, its own heartbeat
// re-triggers recovery later rather than spinning in a tight loop.
const RECOVERY_MIN_INTERVAL_MS = 15_000;

export type SharedWorkerHandle = {
  readonly name: string;
  /** The current instance, spawning one if there isn't a live one. */
  get(): SharedWorker;
  /** Send on the current instance's control port. */
  post(message: unknown, transfer?: Transferable[]): void;
  /**
   * The worker died and was replaced. Anything held against the old instance —
   * a port, a subscription — is stranded; the new one boots with cold state.
   */
  onRecreated(listener: () => void): () => void;
};

/**
 * A SharedWorker a tab keeps alive: spawned on demand, heartbeated, and rebuilt
 * if the browser kills it (which it may, under memory pressure).
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
  let disposeDeathDetection: (() => void) | undefined;
  let recovering = false;
  let lastRecoveryAt = 0;
  const recreatedListeners = new Set<() => void>();

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
    // Replies come back on this port, and we listen with addEventListener
    // rather than onmessage, so it needs start().
    worker.port.start();
    worker.port.addEventListener("message", onMessage);
    worker.port.postMessage({ type: "debug", debug: debugging });

    onSpawn?.(worker);
    disposeDeathDetection = installDeathDetection(worker);
    return worker;
  };

  async function recover(reason: string, dead: SharedWorker): Promise<void> {
    if (dead !== current) return;
    if (recovering) return;
    const now = Date.now();
    if (now - lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS) return;
    recovering = true;
    lastRecoveryAt = now;
    lifecycleLog("recreating the %s SharedWorker (%s)", name, reason);

    try {
      disposeDeathDetection?.();
      disposeDeathDetection = undefined;
      current = undefined;
      try {
        dead.port.close();
      } catch {}

      get();
      for (const listener of recreatedListeners) {
        try {
          listener();
        } catch (error) {
          console.error(`[${name}] recreated listener threw`, error);
        }
      }
    } finally {
      recovering = false;
    }
  }

  function installDeathDetection(worker: SharedWorker): () => void {
    let instanceId: string | undefined;
    let lastHeardAt = Date.now();
    let warnedUnresponsive = false;
    let warnedSendFailed = false;
    let disposed = false;
    let probe: SharedWorker | undefined;
    let seq = 0;

    const closeProbe = () => {
      if (!probe) return;
      try {
        probe.port.close();
      } catch {}
      probe = undefined;
    };

    worker.port.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== "hello" && data?.type !== "pong") return;
      lastHeardAt = Date.now();
      warnedUnresponsive = false;
      closeProbe();
      if (instanceId === undefined) {
        instanceId = data.instanceId;
        lifecycleLog(
          "%s SharedWorker instance %s (via %s)",
          name,
          data.instanceId,
          data.type
        );
      } else if (data.instanceId && data.instanceId !== instanceId) {
        lifecycleLog(
          "%s SharedWorker instance changed (instance %s, was %s)",
          name,
          data.instanceId,
          instanceId
        );
        instanceId = data.instanceId;
      }
    });

    worker.port.addEventListener("close", () => {
      if (disposed) return;
      lifecycleLog("%s SharedWorker control port closed", name);
      void recover("control port closed", worker);
    });

    // Not gated on the debug namespace: a worker that fails to load never
    // replies to anything, and this is the only signal that says so.
    worker.addEventListener("error", (event) => {
      console.error(`${name} SharedWorker error:`, describeErrorEvent(event));
    });

    const startProbe = (reason: string) => {
      if (probe || disposed) return;
      lifecycleLog(
        "%s SharedWorker %s; probing with a second connection",
        name,
        reason
      );
      const startedAt = Date.now();
      const p = new SharedWorker(path(), { name, type: "module" });
      probe = p;
      p.port.start();
      p.port.addEventListener("message", (event: MessageEvent) => {
        if (event.data?.type !== "hello") return;
        setTimeout(() => {
          if (disposed || probe !== p) return;
          closeProbe();
          // The suspect spoke while the probe ran: it was merely busy, and
          // everything queued on it has been delivered.
          if (lastHeardAt >= startedAt) return;
          void recover(
            `port unresponsive on a live worker (${reason}; probe confirmed)`,
            worker
          );
        }, PROBE_GRACE_MS);
      });
      // No hello on the probe means the instance is loading or busy. The probe
      // waits indefinitely rather than tearing anything down on a timer.
    };

    const heartbeat = setInterval(() => {
      try {
        worker.port.postMessage({ type: "ping", id: ++seq });
      } catch (error) {
        // Without this a failed send is indistinguishable from a dead worker.
        if (!warnedSendFailed) {
          warnedSendFailed = true;
          console.error(`${name} SharedWorker ping send threw`, error);
        }
      }

      const neverHeard = instanceId === undefined;
      const silentMs = Date.now() - lastHeardAt;
      const timeoutMs = neverHeard
        ? FIRST_CONTACT_TIMEOUT_MS
        : HEARTBEAT_TIMEOUT_MS;
      if (silentMs <= timeoutMs) return;

      // First contact probes regardless of visibility: SharedWorkers don't
      // suspend with the tab, and the probe destroys nothing. Post-contact
      // silence defers to visibility, since a hidden page's throttling can fake
      // it.
      const visible =
        typeof document === "undefined" ||
        document.visibilityState === "visible";
      if (!neverHeard && !visible) return;

      const seconds = Math.round(silentMs / 1000);
      const reason = neverHeard
        ? `no hello ~${seconds}s after connecting`
        : `no pong for ~${seconds}s`;
      if (!warnedUnresponsive) {
        warnedUnresponsive = true;
        lifecycleLog("%s SharedWorker %s (tab visible)", name, reason);
      }
      startProbe(reason);
    }, HEARTBEAT_MS);

    return () => {
      disposed = true;
      clearInterval(heartbeat);
      closeProbe();
    };
  }

  return {
    name,
    get,
    post(message, transfer) {
      get().port.postMessage(message, transfer ?? []);
    },
    onRecreated(listener) {
      recreatedListeners.add(listener);
      return () => {
        recreatedListeners.delete(listener);
      };
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
