import { describe, it, expect, afterEach } from "vitest";
import {
  Repo,
  SubductionStorageBridge,
  type PeerId,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { Subduction, MemorySigner } from "@automerge/automerge-subduction";
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js";
import {
  MessagePortTransport,
  WorkerSubductionEndpoint,
  WORKER_SUBDUCTION_SERVICE,
} from "../src/worker-link.js";

const repos: Repo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The subduction worker — a bare Subduction node, no Repo — and the Repos that
 * hang off it: tabs, and the automerge worker that resolves URLs for the
 * service worker. `openPort` stands in for the bootloader's control-port
 * handshake.
 */
function site() {
  const subduction = new Subduction({
    signer: new MemorySigner(),
    storage: new SubductionStorageBridge(new DummyStorageAdapter()) as never,
  });
  const accepted: MessagePortTransport[] = [];

  const openPort = async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new MessagePortTransport(port1 as unknown as MessagePort);
    accepted.push(transport);
    // Not awaited, as in the worker: acceptTransport is the responder half of
    // the handshake and only settles once this port's far side initiates.
    void subduction.acceptTransport(transport, WORKER_SUBDUCTION_SERVICE);
    return port2 as unknown as MessagePort;
  };

  return {
    accepted,
    node(peerId: string) {
      const endpoint = new WorkerSubductionEndpoint(openPort);
      const repo = new Repo({
        peerId: peerId as PeerId,
        subductionWebsocketEndpoints: [endpoint],
      });
      repos.push(repo);
      return { repo, endpoint };
    },
  };
}

describe("nodes linked through the subduction worker", () => {
  it("finds another node's document", async () => {
    const { node } = site();
    const tab = node("tab-1").repo;
    const resolver = node("resolver").repo;
    const created = tab.create({ foo: "bar" });
    await pause(500);
    const found = await resolver.find<{ foo: string }>(
      created.url as AutomergeUrl
    );
    expect(found.doc().foo).toBe("bar");
  });

  it("propagates edits both ways", async () => {
    const { node } = site();
    const a = node("tab-1").repo;
    const b = node("tab-2").repo;
    const here = a.create<{ n: number }>({ n: 1 });
    await pause(500);
    const there = await b.find<{ n: number }>(here.url as AutomergeUrl);
    there.change((d) => (d.n = 2));
    await pause(500);
    expect(here.doc().n).toBe(2);
    here.change((d) => (d.n = 3));
    await pause(500);
    expect(there.doc().n).toBe(3);
  });

  it("relays ephemeral messages", async () => {
    const { node } = site();
    const a = node("tab-1").repo;
    const b = node("tab-2").repo;
    const here = a.create<{ n: number }>({ n: 1 });
    await pause(500);
    const there = await b.find<{ n: number }>(here.url as AutomergeUrl);

    const seen: unknown[] = [];
    there.on("ephemeral-message", ({ message }: { message: unknown }) =>
      seen.push(message)
    );
    await pause(200);
    here.broadcast({ hello: "there" });
    await pause(1000);
    expect(seen).toEqual([{ hello: "there" }]);
  });

  it("reconnects on a fresh port when the worker is replaced", async () => {
    const { node, accepted } = site();
    const tab = node("tab-1");
    const other = node("tab-2").repo;
    const before = other.create({ foo: "before" });
    await pause(500);
    await tab.repo.find<{ foo: string }>(before.url as AutomergeUrl);

    // What setup.ts does when its heartbeat gives up on the SharedWorker.
    tab.endpoint.reset();

    const after = other.create({ foo: "after" });
    const found = await tab.repo.find<{ foo: string }>(
      after.url as AutomergeUrl
    );
    expect(found.doc().foo).toBe("after");
    expect(accepted.length).toBe(3);
  });
});
