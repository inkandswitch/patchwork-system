import { describe, it, expect, afterEach } from "vitest";
import {
  Repo,
  type PeerId,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
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
 * A worker repo accepting tab links, and a tab repo whose only network is one
 * of them. `openPort` stands in for the bootloader's control-port handshake.
 */
function link() {
  const worker = new Repo({ peerId: "automerge-worker-1" as PeerId });
  const accepted: MessagePortTransport[] = [];

  const openPort = async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new MessagePortTransport(port1 as unknown as MessagePort);
    accepted.push(transport);
    const subduction = await worker.subduction;
    void subduction.acceptTransport(transport, WORKER_SUBDUCTION_SERVICE);
    return port2 as unknown as MessagePort;
  };

  const endpoint = new WorkerSubductionEndpoint(openPort);
  const tab = new Repo({
    peerId: "tab-1" as PeerId,
    subductionWebsocketEndpoints: [endpoint],
  });
  repos.push(worker, tab);
  return { worker, tab, endpoint, accepted };
}

describe("tab <-> worker over subduction", () => {
  it("finds a worker doc from the tab", async () => {
    const { worker, tab } = link();
    const handle = worker.create({ foo: "bar" });
    const found = await tab.find<{ foo: string }>(handle.url as AutomergeUrl);
    expect(found.doc().foo).toBe("bar");
  });

  it("finds a tab doc from the worker", async () => {
    const { worker, tab } = link();
    const handle = tab.create({ foo: "baz" });
    const found = await worker.find<{ foo: string }>(handle.url as AutomergeUrl);
    expect(found.doc().foo).toBe("baz");
  });

  it("propagates edits both ways", async () => {
    const { worker, tab } = link();
    const a = worker.create<{ n: number }>({ n: 1 });
    const b = await tab.find<{ n: number }>(a.url as AutomergeUrl);
    b.change((d) => (d.n = 2));
    await pause(500);
    expect(a.doc().n).toBe(2);
    a.change((d) => (d.n = 3));
    await pause(500);
    expect(b.doc().n).toBe(3);
  });

  it("reconnects on a fresh port when the worker is replaced", async () => {
    const { worker, tab, endpoint, accepted } = link();
    const first = worker.create({ foo: "before" });
    await tab.find<{ foo: string }>(first.url as AutomergeUrl);

    // What setup.ts does when its heartbeat gives up on the SharedWorker.
    endpoint.reset();
    await pause(2000);
    console.log("accepted after reset:", accepted.length);

    const second = worker.create({ foo: "after" });
    const found = await tab.find<{ foo: string }>(second.url as AutomergeUrl);
    expect(found.doc().foo).toBe("after");
    expect(accepted.length).toBe(2);
  });
});
