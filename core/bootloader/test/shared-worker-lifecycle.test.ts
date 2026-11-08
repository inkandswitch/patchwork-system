import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedWorkerHandle } from "../src/shared-worker-lifecycle.js";
import { FakeSharedWorker, fakeLocks } from "./fake-shared-worker.js";

let locks: ReturnType<typeof fakeLocks>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSharedWorker.instances = [];
  locks = fakeLocks();
  vi.stubGlobal("SharedWorker", FakeSharedWorker);
  vi.stubGlobal("navigator", { locks });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const instances = () => FakeSharedWorker.instances;

function handle() {
  return sharedWorkerHandle("test", () => "/worker.js", {
    debugging: false,
    onMessage() {},
  });
}

/** The nth instance dies the way a failing worker does: said, then gone. */
function closeItself(n: number) {
  instances()[n].port.receive({ type: "restarting", reason: "test" });
  instances()[n].port.receive({ type: "closing" });
}

describe("a worker that dies mid-restart", () => {
  it("delivers posts made after its port closed to the replacement", () => {
    const h = handle();
    h.get();
    instances()[0].port.receive({ type: "alive", lock: "lock-0" });
    instances()[0].port.receive({ type: "restarting", reason: "newer tab" });
    h.post({ n: 1 });
    instances()[0].port.fireClose();
    locks.release("lock-0");
    h.post({ n: 2 });

    expect(instances()).toHaveLength(2);
    expect(instances()[1].posted).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("does the same when the worker never said it was alive", () => {
    const h = handle();
    h.get();
    instances()[0].port.receive({ type: "restarting", reason: "newer tab" });
    h.post({ n: 1 });
    instances()[0].port.fireClose();
    h.post({ n: 2 });

    expect(instances()).toHaveLength(2);
    expect(instances()[1].posted).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("hears the lock release alone", () => {
    const h = handle();
    h.get();
    instances()[0].port.receive({ type: "alive", lock: "lock-0" });
    instances()[0].port.receive({ type: "restarting", reason: "newer tab" });
    h.post({ n: 1 });
    locks.release("lock-0");

    expect(instances()).toHaveLength(2);
    expect(instances()[1].posted).toEqual([{ n: 1 }]);
  });
});

describe("respawning", () => {
  it("respawns the first few quick restarts at once, then backs off", () => {
    const h = handle();
    h.get();
    // three immediate replacements
    for (let n = 0; n < 3; n++) closeItself(n);
    expect(instances()).toHaveLength(4);

    closeItself(3);
    expect(instances()).toHaveLength(4);
    expect(h.state.phase).toBe("waiting");
    vi.advanceTimersByTime(499);
    expect(instances()).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(instances()).toHaveLength(5);

    // the wait doubles
    closeItself(4);
    vi.advanceTimersByTime(999);
    expect(instances()).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(instances()).toHaveLength(6);
  });

  it("caps the wait", () => {
    const h = handle();
    h.get();
    for (let n = 0; n < 12; n++) {
      closeItself(n);
      vi.advanceTimersByTime(10_000);
    }
    closeItself(12);
    vi.advanceTimersByTime(9_999);
    expect(instances()).toHaveLength(13);
    vi.advanceTimersByTime(1);
    expect(instances()).toHaveLength(14);
  });

  it("starts over once an instance has stayed up", () => {
    const h = handle();
    h.get();
    for (let n = 0; n < 4; n++) {
      closeItself(n);
      vi.advanceTimersByTime(10_000);
    }
    const before = instances().length;
    vi.advanceTimersByTime(60_000);
    closeItself(before - 1);
    expect(instances()).toHaveLength(before + 1);
    expect(h.state.phase).toBe("running");
  });

  it("holds posts made while waiting and delivers them to the replacement", () => {
    const h = handle();
    h.get();
    for (let n = 0; n < 4; n++) {
      closeItself(n);
      if (n === 3) break;
    }
    expect(h.state.phase).toBe("waiting");
    h.post({ n: 1 });
    h.post({ n: 2 });
    vi.advanceTimersByTime(100);
    h.post({ n: 3 });
    // none of that spawned anything
    expect(instances()).toHaveLength(4);

    vi.advanceTimersByTime(400);
    expect(instances()).toHaveLength(5);
    expect(instances()[4].posted).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(h.state.phase).toBe("running");
  });

  it("spawns early when something asks for the worker itself", () => {
    const h = handle();
    h.get();
    for (let n = 0; n < 4; n++) closeItself(n);
    h.post({ n: 1 });
    const worker = h.get();
    expect(worker).toBe(instances()[4]);
    expect(instances()[4].posted).toEqual([{ n: 1 }]);
    vi.advanceTimersByTime(60_000);
    expect(instances()).toHaveLength(5);
  });
});

describe("state", () => {
  it("names the phase, why, and since when", () => {
    vi.setSystemTime(1_000);
    const h = handle();
    expect(h.state).toMatchObject({ phase: "none" });
    h.get();
    expect(h.state).toMatchObject({ phase: "running", since: 1_000 });
    vi.setSystemTime(2_000);
    instances()[0].port.receive({ type: "alive", lock: "l" });
    expect(h.state).toMatchObject({ phase: "running", alive: true });
    instances()[0].port.receive({ type: "restarting", reason: "newer tab" });
    expect(h.state).toMatchObject({
      phase: "winding-down",
      reason: "newer tab",
      since: 2_000,
    });
  });

  it("says when the next try is", () => {
    const h = handle();
    h.get();
    vi.setSystemTime(Date.now());
    for (let n = 0; n < 4; n++) closeItself(n);
    expect(h.state).toMatchObject({
      phase: "waiting",
      retryAt: Date.now() + 500,
    });
  });
});
