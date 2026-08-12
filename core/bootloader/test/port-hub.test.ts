import { describe, it, expect, afterEach } from "vitest";
import {
  Repo,
  type PeerId,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { PortHubAdapter, WORKER_SUBDUCTION_SERVICE } from "../src/port-hub.js";

const repos: Repo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pair() {
  const { port1, port2 } = new MessageChannel();
  const workerHub = new PortHubAdapter();
  const tabHub = new PortHubAdapter();
  const worker = new Repo({
    peerId: "automerge-worker-1" as PeerId,
    subductionAdapters: [
      {
        adapter: workerHub,
        serviceName: WORKER_SUBDUCTION_SERVICE,
        role: "accept",
      },
    ],
  });
  const tab = new Repo({
    peerId: "tab-1" as PeerId,
    subductionAdapters: [
      {
        adapter: tabHub,
        serviceName: WORKER_SUBDUCTION_SERVICE,
        role: "connect",
      },
    ],
  });
  repos.push(worker, tab);
  workerHub.addPort(port1 as unknown as MessagePort);
  tabHub.addPort(port2 as unknown as MessagePort);
  return { worker, tab, workerHub, tabHub };
}

describe("tab <-> worker over subduction", () => {
  it("worker doc is findable in the tab", async () => {
    const { worker, tab, tabHub } = pair();
    await tabHub.whenReady();
    const handle = worker.create({ foo: "bar" });
    const found = await tab.find<{ foo: string }>(handle.url as AutomergeUrl);
    expect(found.doc().foo).toBe("bar");
  });

  it("worker doc created before the link is findable in the tab", async () => {
    const { worker, tab, tabHub } = pair();
    const handle = worker.create({ foo: "bar" });
    await tabHub.whenReady();
    await pause(500);
    const found = await tab.find<{ foo: string }>(handle.url as AutomergeUrl);
    expect(found.doc().foo).toBe("bar");
  });

  it("tab doc is findable in the worker", async () => {
    const { worker, tab, tabHub } = pair();
    await tabHub.whenReady();
    const handle = tab.create({ foo: "baz" });
    const found = await worker.find<{ foo: string }>(
      handle.url as AutomergeUrl
    );
    expect(found.doc().foo).toBe("baz");
  });

  it("edits propagate both ways", async () => {
    const { worker, tab, tabHub } = pair();
    await tabHub.whenReady();
    const a = worker.create<{ n: number }>({ n: 1 });
    const b = await tab.find<{ n: number }>(a.url as AutomergeUrl);
    b.change((d) => (d.n = 2));
    await pause(1000);
    expect(a.doc().n).toBe(2);
    a.change((d) => (d.n = 3));
    await pause(1000);
    expect(b.doc().n).toBe(3);
  });
});
