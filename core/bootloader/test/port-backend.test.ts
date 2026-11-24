// Tabs' Repos on PortBackends, served by one worker backend over
// MessageChannels: what one tab writes the other sees, and both carry on
// when the worker is replaced.
import "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo/slim";
import {
  MemoryBackend,
  type SedimentreeId,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";
import type {
  EphemeralEnvelope,
  EphemeralSession,
} from "@automerge/automerge-repo-subduction";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "../src/hub/event-queue.js";
import { PortBackend } from "../src/hub/port-backend.js";
import { serveClient } from "../src/hub/serve.js";

type Doc = { n: number; items?: string[] };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // tabs shut down first, while their workers can still answer
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A tab: a PortBackend holding a Web Lock while it lives. */
async function tab() {
  const lock = `tab-${crypto.randomUUID()}`;
  let release!: () => void;
  await new Promise<void>((held) => {
    void navigator.locks.request(lock, () => {
      held();
      return new Promise<void>((r) => (release = r));
    });
  });
  const backend = new PortBackend(lock);
  const repo = new Repo({ backend });
  cleanups.push(async () => {
    await repo.shutdown();
    release();
  });
  return { backend, repo, close: release };
}

/** Connect `backend` to a worker serving `worker`. */
function connect(backend: PortBackend, worker: MemoryBackend) {
  const { port1, port2 } = new MessageChannel();
  serveClient(port2, { backend: worker, peerId: "worker" });
  backend.attach(port1);
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
}

/**
 * A worker backend that relays ephemerals, as subduction does: a message
 * published on one session of a document reaches every session of it,
 * the publisher's included, as an `ephemeral` extension event.
 */
class RelayBackend extends MemoryBackend {
  readonly #queues = new Map<SedimentreeId, Set<EventQueue<unknown>>>();

  override open(id: SedimentreeId): EphemeralSession {
    const inner: SedimentreeSession = super.open(id);
    const queue = new EventQueue<unknown>();
    const queues = this.#queues.get(id) ?? new Set();
    this.#queues.set(id, queues.add(queue));
    void (async () => {
      for await (const event of inner.events) queue.push(event);
    })();
    let sequence = 0;
    return {
      events: queue as EphemeralSession["events"],
      markReady: () => inner.markReady(),
      close: async () => {
        queues.delete(queue);
        queue.end();
        await inner.close();
      },
      publishEphemeral: async (message: EphemeralEnvelope) => {
        for (const q of queues)
          q.push({
            type: "extension",
            kind: "ephemeral",
            sequence: sequence++,
            payload: {
              message,
              sender: { kind: "peer", id: "worker", path: [] },
            },
          });
      },
    };
  }
}

const until = (f: () => boolean) =>
  vi.waitUntil(f, { timeout: 5_000, interval: 10 });

describe("PortBackend", () => {
  it("shares documents between tabs through the worker", async () => {
    const worker = new MemoryBackend();
    const [a, b] = await Promise.all([tab(), tab()]);
    connect(a.backend, worker);
    connect(b.backend, worker);

    const handle = await a.repo.create<Doc>({ n: 1 });
    await handle.change((d) => {
      d.n = 2;
    });
    const found = await b.repo.find<Doc>(handle.url);
    await until(() => found.doc()?.n === 2);

    await found.change((d) => {
      d.items = ["from b"];
    });
    await until(() => handle.doc()?.items?.[0] === "from b");
  });

  it("waits for a worker before answering", async () => {
    const worker = new MemoryBackend();
    const a = await tab();
    const created = a.repo.create<Doc>({ n: 1 });
    await new Promise((r) => setTimeout(r, 20));
    connect(a.backend, worker);
    const handle = await created;
    expect(handle.doc()).toEqual({ n: 1 });
  });

  it("carries on with a replacement worker", async () => {
    const worker = new MemoryBackend();
    const [a, b] = await Promise.all([tab(), tab()]);
    connect(a.backend, worker);
    connect(b.backend, worker);
    const handle = await a.repo.create<Doc>({ n: 1 });
    const found = await b.repo.find<Doc>(handle.url);

    // the worker restarts: a new instance on the same storage, new ports
    connect(a.backend, worker);
    connect(b.backend, worker);

    await handle.change((d) => {
      d.n = 5;
    });
    await until(() => found.doc()?.n === 5);
    // the reopened session's initial load didn't count as a second load
    expect(found.doc()).toEqual({ n: 5 });
  });

  it("carries ephemeral messages between tabs", async () => {
    const worker = new RelayBackend();
    const [a, b] = await Promise.all([tab(), tab()]);
    connect(a.backend, worker);
    connect(b.backend, worker);
    const handle = await a.repo.create<Doc>({ n: 1 });
    const found = await b.repo.find<Doc>(handle.url);

    const heard: [string, unknown, string][] = [];
    handle.on("ephemeral-message", ({ message, originId }) =>
      heard.push(["a", message, originId])
    );
    found.on("ephemeral-message", ({ message, originId }) =>
      heard.push(["b", message, originId])
    );
    handle.broadcast({ hello: "from a" });
    await until(() => heard.length > 0);
    found.broadcast({ hello: "from b" });
    await until(() => heard.length > 1);
    // Neither hears its own: the relay echoes every message back to the tab
    // that sent it, ahead of the other's reply, and the extension drops it.
    expect(heard).toEqual([
      ["b", { hello: "from a" }, a.repo.id],
      ["a", { hello: "from b" }, b.repo.id],
    ]);
  });
});
