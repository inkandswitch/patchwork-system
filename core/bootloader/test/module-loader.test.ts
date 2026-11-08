import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/emitted.js", () => ({ MODULE_LOADER_WORKER: "/loader.js" }));
vi.mock("@inkandswitch/patchwork-filesystem", () => ({
  importPluginFromFolderDocUrl: vi.fn(),
}));

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  sent: any[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(data: unknown) {
    this.sent.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  say(data: unknown) {
    const event = new Event("message");
    (event as any).data = data;
    this.dispatchEvent(event);
  }
  fail(message = "boom") {
    const event = new Event("error");
    (event as any).message = message;
    this.dispatchEvent(event);
  }
}

let load: (url: string) => Promise<{ plugins: unknown[] }>;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.resetModules();
  ({ importAutomergePackageViaWorker: load } =
    await import("../src/module-loader.js"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const workers = () => FakeWorker.instances;

describe("module loader worker", () => {
  it("resolves a request from its reply", async () => {
    const result = load("automerge:a");
    workers()[0].say({
      type: "descriptors",
      id: workers()[0].sent[0].id,
      descriptors: [],
    });
    await expect(result).resolves.toEqual({ plugins: [] });
  });

  it("rejects what is pending when the worker errors, and spawns a new one next time", async () => {
    const first = load("automerge:a");
    const second = load("automerge:b");
    const caught = Promise.allSettled([first, second]);
    workers()[0].fail("script failed");
    const results = await caught;
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(String((results[0] as any).reason)).toContain("script failed");
    expect(workers()[0].terminated).toBe(true);

    const third = load("automerge:c");
    expect(workers()).toHaveLength(2);
    workers()[1].say({
      type: "descriptors",
      id: workers()[1].sent[0].id,
      descriptors: [],
    });
    await expect(third).resolves.toEqual({ plugins: [] });
  });

  it("ignores a late error from a worker it already dropped", async () => {
    const first = load("automerge:a");
    first.catch(() => {});
    workers()[0].fail();
    const second = load("automerge:b");
    workers()[0].fail("late");
    workers()[1].say({
      type: "descriptors",
      id: workers()[1].sent[0].id,
      descriptors: [],
    });
    await expect(second).resolves.toEqual({ plugins: [] });
  });

  it("gives up on a request the worker never answers", async () => {
    const result = load("automerge:a");
    const caught = result.catch((error) => error);
    vi.advanceTimersByTime(60_000);
    expect(String(await caught)).toContain("timed out");
    // a reply after that is ignored, and the worker is still used
    workers()[0].say({
      type: "descriptors",
      id: workers()[0].sent[0].id,
      descriptors: [],
    });
    const next = load("automerge:b");
    expect(workers()).toHaveLength(1);
    workers()[0].say({
      type: "descriptors",
      id: workers()[0].sent[1].id,
      descriptors: [],
    });
    await expect(next).resolves.toEqual({ plugins: [] });
  });
});
