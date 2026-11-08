import debug from "debug";
import { buildId } from "./build-id.js";
import type {
  AliveMessage,
  ClosingMessage,
  RestartingMessage,
} from "./worker-control.js";

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
  /**
   * The current instance, spawning one if there isn't a live one. Asking for
   * the worker itself spawns it even while a respawn is being held back.
   */
  get(): SharedWorker;
  /** Send on the current instance's control port. */
  post(message: unknown, transfer?: Transferable[]): void;
  /** Ask the current instance to close itself; the next use spawns a fresh one. */
  restart(reason: string): void;
  /**
   * Something outside this tab says there's no instance. Unless this tab has
   * heard its instance is alive, connect afresh: to the same one if it's
   * still booting, to a new one if it's gone.
   */
  revive(): void;
  /** What the handle is doing now, for showing to someone. */
  readonly state: SharedWorkerState;
};

/**
 * What a handle is doing. `none`: nothing spawned yet. `running`: an instance
 * is up (`alive` once it has said it holds its lock). `winding-down`: it said
 * it's restarting, so posts are held for its replacement. `waiting`: it's
 * gone and the replacement is being held back (`retryAt`) because instances
 * keep going soon after they start.
 */
export type SharedWorkerState = {
  phase: "none" | "running" | "winding-down" | "waiting";
  /** Why it is in this phase: what the worker or the handle said. */
  reason: string;
  /** When it entered this phase, as a `Date.now()`. */
  since: number;
  /** Whether the current instance has said it holds its lock. */
  alive: boolean;
  /** Posts held back for the next instance. */
  held: number;
  /** When the next instance will be spawned, while `waiting`. */
  retryAt?: number;
  /** Instances in a row that went within STABLE_AFTER_MS of starting. */
  quickRestarts: number;
};

// The first few quick restarts respawn at once: a deploy restarts a worker
// once or twice by itself (a newer tab arrives, then the one after it), and
// one bad start is worth retrying straight away. Past that something is
// failing on every start, so wait, doubling from half a second to ten: long
// enough not to spin a core and the network, short enough that a transient
// failure (offline on a first visit) recovers soon after it clears.
const IMMEDIATE_RESTARTS = 3;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 10_000;
// An instance that lasted this long was working, so the count starts over.
const STABLE_AFTER_MS = 30_000;

type Held = Array<[unknown, Transferable[]]>;
type Instance = { worker: SharedWorker; startedAt: number; alive: boolean };
type Phase =
  | { phase: "none" }
  | { phase: "running"; instance: Instance }
  | { phase: "winding-down"; instance: Instance; held: Held }
  | {
      phase: "waiting";
      held: Held;
      timer: ReturnType<typeof setTimeout>;
      retryAt: number;
      // The instance went without saying so, so `onGone` is owed.
      silent: boolean;
    };
type State = Phase & { reason: string; since: number };

/**
 * A SharedWorker a tab keeps alive: spawned on demand, and respawned if the
 * browser terminates it (which it may, under memory pressure) or it restarts
 * itself because a tab from a newer build connected.
 *
 * Browser termination shows up as `close` on the control port, in Chromium.
 * A self-restart doesn't (Chromium never fires it for a worker that called
 * `self.close()`), so the worker announces it instead: `restarting` when it
 * decides to, and `closing` as its last word, which is when the replacement
 * is spawned. A worker that holds a Web Lock for its lifetime says so
 * (`alive`), and the tab waits on that lock too: it's released when the
 * worker goes, however it goes, in any browser.
 *
 * A worker that keeps going soon after it starts is respawned after a growing
 * wait rather than at once. Posts made meanwhile, or while an instance winds
 * down, are held and delivered to its replacement.
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
    onGone,
  }: {
    debugging: boolean;
    onMessage: (event: MessageEvent) => void;
    onSpawn?: (worker: SharedWorker) => void;
    /** The worker announced it's closing to be replaced. */
    onRestarting?: (message: RestartingMessage) => void;
    /**
     * An instance went without saying so (its port closed or its lock was
     * released), and a replacement has been spawned. Anything else talking to
     * it, on ports of its own, needs to reconnect.
     */
    onGone?: () => void;
  }
): SharedWorkerHandle {
  let state: State = {
    phase: "none",
    reason: "not started",
    since: Date.now(),
  };
  let quickRestarts = 0;

  const enter = (next: Phase, reason: string) => {
    state = { ...next, reason, since: Date.now() };
  };

  const heldOf = (): Held =>
    state.phase === "winding-down" || state.phase === "waiting"
      ? state.held
      : [];

  const instanceOf = (worker: SharedWorker): Instance | undefined =>
    (state.phase === "running" || state.phase === "winding-down") &&
    state.instance.worker === worker
      ? state.instance
      : undefined;

  // Start an instance and give it what was held for it.
  const launch = (held: Held, reason: string, silent: boolean) => {
    const worker = new SharedWorker(path(), { name, type: "module" });
    const instance: Instance = { worker, startedAt: Date.now(), alive: false };
    enter({ phase: "running", instance }, reason);
    listen(worker);
    worker.port.postMessage({ type: "debug", debug: debugging });
    // The worker compares this against its own build and restarts if we're
    // newer — see startWorkerControl.
    worker.port.postMessage({ type: "hello", build: buildId });

    onSpawn?.(worker);
    for (const [message, transfer] of held)
      worker.port.postMessage(message, transfer);
    if (silent) onGone?.();
    return worker;
  };

  // none | waiting -> running; running already is.
  const spawn = (reason: string, silent = false): SharedWorker => {
    if (state.phase === "running" || state.phase === "winding-down")
      return state.instance.worker;
    const held = heldOf();
    if (state.phase === "waiting") clearTimeout(state.timer);
    return launch(held, reason, silent);
  };

  // running -> winding-down: the worker said it's restarting.
  const windDown = (worker: SharedWorker, reason: string) => {
    const instance = instanceOf(worker);
    if (state.phase !== "running" || !instance) return;
    enter({ phase: "winding-down", instance, held: [] }, reason);
  };

  const markAlive = (worker: SharedWorker) => {
    const instance = instanceOf(worker);
    if (instance) instance.alive = true;
  };

  // running | winding-down -> running | waiting: the instance is over, however
  // it went. The next one starts at once unless instances keep going soon
  // after they start.
  const lose = (worker: SharedWorker, reason: string, silent: boolean) => {
    const instance = instanceOf(worker);
    if (!instance) return;
    worker.port.close();
    const held = heldOf();
    const lasted = Date.now() - instance.startedAt;
    quickRestarts = lasted >= STABLE_AFTER_MS ? 1 : quickRestarts + 1;
    const delay = backoff(quickRestarts);
    if (delay === 0) {
      launch(held, reason, silent);
      return;
    }
    lifecycleLog("%s SharedWorker respawning in %dms", name, delay);
    const retryAt = Date.now() + delay;
    const timer = setTimeout(() => {
      if (state.phase !== "waiting") return;
      spawn("retrying after a wait", state.silent);
    }, delay);
    enter({ phase: "waiting", held, timer, retryAt, silent }, reason);
  };

  const listen = (worker: SharedWorker) => {
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
    // Fires when the worker is terminated.
    worker.port.addEventListener("close", () => {
      if (!instanceOf(worker)) return;
      lifecycleLog("%s SharedWorker control port closed", name);
      lose(worker, "its port closed", true);
    });
    // Replies come back on this port, and we listen with addEventListener
    // rather than onmessage, so it needs start().
    worker.port.start();
    worker.port.addEventListener("message", (event) => {
      const type = event.data?.type;
      if (type === "restarting") {
        const message = event.data as RestartingMessage;
        lifecycleLog("%s SharedWorker restarting: %s", name, message.reason);
        windDown(worker, message.reason);
        onRestarting?.(message);
        return;
      }
      if (type === "closing") {
        lifecycleLog("%s SharedWorker closed itself, respawning", name);
        lose(worker, "it closed itself", false);
        return;
      }
      if (type === "alive") {
        const { lock } = event.data as AliveMessage;
        if (!instanceOf(worker)) return;
        markAlive(worker);
        // Shared, so every tab waiting is told at once; it can't be granted
        // while the worker holds the lock exclusively.
        void navigator.locks?.request(lock, { mode: "shared" }, () => {
          // Already replaced: by its `closing`, or its port closing.
          if (!instanceOf(worker)) return;
          lifecycleLog("%s SharedWorker is gone, respawning", name);
          lose(worker, "its lock was released", true);
        });
        return;
      }
      onMessage(event);
    });
  };

  return {
    name,
    get: () => spawn("asked for"),
    get state() {
      return {
        phase: state.phase,
        reason: state.reason,
        since: state.since,
        alive:
          (state.phase === "running" || state.phase === "winding-down") &&
          state.instance.alive,
        held: heldOf().length,
        retryAt: state.phase === "waiting" ? state.retryAt : undefined,
        quickRestarts,
      };
    },
    post(message, transfer) {
      const args: [unknown, Transferable[]] = [message, transfer ?? []];
      if (state.phase === "running")
        state.instance.worker.port.postMessage(...args);
      else if (state.phase === "none")
        spawn("a post").port.postMessage(...args);
      // Winding down, or waiting to respawn: for the replacement.
      else state.held.push(args);
    },
    restart(reason) {
      if (state.phase === "running")
        state.instance.worker.port.postMessage({ type: "restart", reason });
    },
    revive() {
      if (state.phase === "waiting") return;
      if (state.phase === "none") {
        lifecycleLog("%s SharedWorker missing, connecting afresh", name);
        spawn("revived", true);
        return;
      }
      if (state.instance.alive) return;
      lifecycleLog("%s SharedWorker missing, connecting afresh", name);
      lose(state.instance.worker, "revived", true);
    },
  };
}

function backoff(quickRestarts: number): number {
  if (quickRestarts <= IMMEDIATE_RESTARTS) return 0;
  const exponent = quickRestarts - IMMEDIATE_RESTARTS - 1;
  return Math.min(BACKOFF_FIRST_MS * 2 ** exponent, BACKOFF_MAX_MS);
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
