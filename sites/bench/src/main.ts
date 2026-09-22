// A page that builds one Repo in one of five topologies and exposes enough
// for the playwright specs in ../tests to time it. No UI, no account, no
// package list: the shell is out of scope here.
//
//   ?mode=patchwork      what patchwork does: createRepo() — the tab's own
//                        subduction node with this origin's IndexedDB, its own
//                        server socket and the siblings BroadcastChannel — plus
//                        the automerge worker that resolves URLs for the
//                        service worker
//   ?mode=pertab         the bare node: storage + socket, no siblings channel,
//                        no workers, so tabs only meet through the server (or
//                        the database)
//   ?mode=pertab-bc      pertab plus classic automerge sync between tabs over a
//                        BroadcastChannel
//   ?mode=pertab-mesh    pertab plus patchwork's siblings mesh (subduction over
//                        a BroadcastChannel), but each tab signing as itself:
//                        the shipped topology minus the shared signer, the
//                        service worker and the automerge worker
//   ?mode=tab-worker     the node in a dedicated Worker the tab spawns: storage,
//                        socket and a mesh to the other tabs' workers live
//                        there; the tab is a storageless Repo on a MessagePort
//   ?mode=shared-worker  one node in a SharedWorker for every tab; each tab is a
//                        storageless Repo on a MessagePort to it
//
// `?server=none` runs everything but patchwork with no socket, so tabs can only
// meet through storage (and whatever local channel the mode has).
// `?storage=worker` swaps in-thread IndexedDB for the IndexedDB worker adapter
// in the bare per-tab modes; `?mesh=1` gives them patchwork's siblings mesh
// (subduction over a BroadcastChannel) and `?signer=shared` patchwork's
// origin-wide signer, so the shipped topology can be taken apart one piece at
// a time. `?serverPeer=` names the sync server's subduction peer id; without
// it the server is whichever peer isn't this tab.
import {
  parseAutomergeUrl,
  Repo,
  type AutomergeUrl,
  type DocHandle,
  type PeerId,
} from "@automerge/automerge-repo/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
import { createRepo, initWasm } from "@inkandswitch/patchwork";
import setupServiceWorker from "@inkandswitch/patchwork-bootloader";
import { loadOrCreateSigner } from "@inkandswitch/patchwork-bootloader/signer";
import { WorkerSubductionEndpoint } from "./worker-link.js";
import type { ControlPort, NodeMessage, TabMessage } from "./protocol.js";

declare const __SYNC_SERVER__: { url: string };

type Mode =
  | "patchwork"
  | "pertab"
  | "pertab-bc"
  | "pertab-mesh"
  | "tab-worker"
  | "shared-worker";
type Storage = "worker" | "direct";

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "patchwork") as Mode;
const storage = (params.get("storage") ?? "direct") as Storage;
const serverUrl = params.get("server") ?? __SYNC_SERVER__.url;
const serverPeer = params.get("serverPeer") ?? undefined;
const stop = params.get("stop");
const workerMode = mode === "tab-worker" || mode === "shared-worker";

const marks: Record<string, number> = {};
const mark = (name: string) => (marks[name] ??= performance.now());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const serverHeads = new Map<string, string[]>();
let serverPeerIds = new Set<string>();
const online = Promise.withResolvers<number>();
let isOnline: () => Promise<boolean> = async () => false;
let setOffline: (offline: boolean) => void = () => {};
const workerErrors: string[] = [];
const workerLog: string[] = [];
const remoteHeadsSeen: unknown[] = [];
const siblings = params.has("siblings")
  ? params.get("siblings") === "1"
  : mode === "tab-worker";
const mesh = params.has("mesh")
  ? params.get("mesh") === "1"
  : mode === "pertab-mesh";

function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}

function storageAdapter() {
  return storage === "direct"
    ? new IndexedDBStorageAdapter()
    : new IndexedDBWorkerStorageAdapter();
}

// ── Tab modes: the node is this Repo ────────────────────────────────────

async function buildTabNode(): Promise<Repo> {
  let repo: Repo;
  let ownPeerId: string;
  if (mode === "patchwork") {
    const sw = await setupServiceWorker();
    if (!sw) throw new Error("no service worker");
    mark("workers");
    const tab = await createRepo();
    repo = tab.repo;
    ownPeerId = tab.signerIdentity!.peerId;
  } else {
    const storage = storageAdapter();
    const signer =
      params.get("signer") === "shared"
        ? await loadOrCreateSigner(storage)
        : new MemorySigner();
    ownPeerId = signer.peerId().toString();
    repo = new Repo({
      signer,
      storage,
      peerId: `bench-tab-${crypto.randomUUID()}` as PeerId,
      subductionWebsocketEndpoints: serverUrl === "none" ? [] : [serverUrl],
      network:
        mode === "pertab-bc"
          ? [new BroadcastChannelNetworkAdapter({ channelName: "bench" })]
          : [],
      subductionAdapters: mesh
        ? [
            {
              adapter: new BroadcastChannelNetworkAdapter({
                channelName: "bench-mesh",
              }),
              serviceName: "bench-mesh",
              role: "mesh",
            },
          ]
        : [],
      enableRemoteHeadsGossiping: true,
    });
  }
  mark("repo");

  // Every other node on this origin (siblings, the automerge worker) signs as
  // this tab does in patchwork mode, and doesn't exist in the bare modes, so
  // without a known server peer the server is whoever isn't us. A mesh with
  // distinct signers has no such tell, so it insists on the probe.
  if (!serverPeer && serverUrl !== "none" && mesh) {
    throw new Error("?serverPeer= is required for a mesh of distinct signers");
  }
  const isServer = (id: string) =>
    serverPeer ? id === serverPeer : id !== ownPeerId;
  const connectedServers = async () =>
    (await repo.connectedSubductionPeerIds()).filter(isServer);

  repo.on("subduction-remote-heads", ({ documentId, storageId, heads }) => {
    if (!isServer(storageId)) return;
    serverHeads.set(documentId, [...heads]);
  });
  isOnline = async () => (await connectedServers()).length > 0;

  if (serverUrl === "none") {
    online.resolve(performance.now());
  } else {
    // Polled rather than taken from `subduction-connection`: that event is
    // the aggregate over every peer, and a sibling can flip it before the
    // server link is up.
    void (async () => {
      for (;;) {
        const servers = await connectedServers();
        if (servers.length) {
          serverPeerIds = new Set(servers);
          online.resolve(performance.now());
          return;
        }
        await sleep(10);
      }
    })();
  }
  return repo;
}

// ── Worker modes: the node is in a worker, this Repo is storageless ─────

const PORT_TIMEOUT_MS = 10_000;

function spawnControl(): { control: ControlPort; errors: EventTarget } {
  if (mode === "tab-worker") {
    const worker = new Worker(
      new URL("./subduction-worker.ts", import.meta.url),
      { type: "module" }
    );
    return { control: worker, errors: worker };
  }
  const shared = new SharedWorker(
    new URL("./subduction-shared-worker.ts", import.meta.url),
    { type: "module", name: "bench-subduction" }
  );
  return { control: shared.port, errors: shared };
}

async function buildWorkerNode(): Promise<Repo> {
  const { control, errors } = spawnControl();
  const send = (message: TabMessage, transfer?: Transferable[]) =>
    control.postMessage(message, transfer);
  let connected = false;
  errors.addEventListener("error", (event) => {
    const message = (event as ErrorEvent).message ?? "worker failed to load";
    workerErrors.push(message);
    console.error("[subduction worker]", message);
  });

  control.addEventListener("message", (event) => {
    const message = event.data as NodeMessage;
    switch (message.type) {
      case "connection":
        connected = message.connected;
        if (connected) online.resolve(performance.now());
        return;
      case "remote-heads":
        remoteHeadsSeen.push(message);
        if (message.storageId !== serverPeer) return;
        serverHeads.set(message.documentId, message.heads);
        return;
      case "ready":
        mark("node");
        serverPeerIds = new Set(serverPeer ? [serverPeer] : []);
        return;
      case "error":
        workerErrors.push(message.message);
        console.error("[subduction worker]", message.message);
        return;
      case "log":
        workerLog.push(message.message);
        return;
    }
  });
  control.start?.();
  send({
    type: "config",
    config: { server: serverUrl, serverPeer, siblings },
  });
  send({ type: "status" });

  // Bounded so a worker that never answers feeds automerge-repo's reconnect
  // loop instead of hanging it.
  let nextPortId = 0;
  const openPort = () =>
    new Promise<MessagePort>((resolve, reject) => {
      const id = ++nextPortId;
      const { port1, port2 } = new MessageChannel();
      const timer = setTimeout(() => {
        control.removeEventListener("message", listener);
        reject(new Error(`worker didn't accept a port within ${PORT_TIMEOUT_MS}ms`));
      }, PORT_TIMEOUT_MS);
      const listener = (event: MessageEvent) => {
        const message = event.data as NodeMessage;
        if (!("id" in message) || message.id !== id) return;
        clearTimeout(timer);
        control.removeEventListener("message", listener);
        if (message.type === "port-ready") resolve(port1);
        else reject(new Error(`worker refused the port: ${message.error}`));
      };
      control.addEventListener("message", listener);
      send({ type: "port", id }, [port2]);
    });

  const signer = new MemorySigner();
  const repo = new Repo({
    signer,
    peerId: `bench-tab-${crypto.randomUUID()}` as PeerId,
    subductionWebsocketEndpoints: [new WorkerSubductionEndpoint(openPort)],
    enableRemoteHeadsGossiping: true,
  });
  mark("repo");
  // The only subduction peer this Repo has is the worker, so this is the link
  // to it, not to the server.
  repo.on("subduction-connection", ({ connected }) => {
    if (connected) mark("linked");
  });

  if (serverUrl === "none") online.resolve(performance.now());
  isOnline = async () => connected;
  setOffline = (offline) => send({ type: "offline", offline });
  return repo;
}

async function build(): Promise<Repo | null> {
  mark("start");
  if (stop === "js") return null;
  await initWasm();
  mark("wasm");
  if (stop === "wasm") return null;
  return workerMode ? buildWorkerNode() : buildTabNode();
}

// `find` settles as unavailable when every source has said no, and a sibling
// tab's brand-new doc may not have reached those sources yet. A plain second
// `find` returns the same settled query, so each retry asks the Repo for a
// real re-sync first, which is what an app would have to do; the attempt count
// is reported so the benches can say how often it was needed. The deadline
// also bounds a find that stays pending.
async function find(
  url: string,
  timeoutMs = 30_000
): Promise<{ handle: DocHandle<Record<string, unknown>>; attempts: number }> {
  const deadline = performance.now() + timeoutMs;
  const { documentId } = parseAutomergeUrl(url as AutomergeUrl);
  for (let attempts = 1; ; attempts++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(`${url} not found within ${timeoutMs}ms (${attempts - 1} retries)`);
    }
    try {
      const handle = await window.repo.find<Record<string, unknown>>(
        url as AutomergeUrl,
        { signal: AbortSignal.timeout(remaining) }
      );
      await handle.whenReady();
      return { handle, attempts };
    } catch (error) {
      if (performance.now() > deadline) throw error;
      window.repo.resyncSubduction(documentId);
      await sleep(50);
    }
  }
}

const ONLINE_TIMEOUT_MS = 60_000;

// How long the main thread was unavailable: a short timer's lateness, plus
// whatever the browser reports as long tasks.
type Stall = {
  timer: ReturnType<typeof setInterval>;
  expected: number;
  maxMs: number;
  totalMs: number;
  longTasks: number;
  longTaskMs: number;
  observer?: PerformanceObserver;
};
let stall: Stall | null = null;
const STALL_INTERVAL_MS = 5;

window.bench = {
  mode,
  storage,
  marks,
  find,
  online: (timeoutMs = ONLINE_TIMEOUT_MS) =>
    Promise.race([
      online.promise,
      sleep(timeoutMs).then(() => {
        throw new Error(`server not connected within ${timeoutMs}ms`);
      }),
    ]),
  isOnline: () => isOnline(),
  setOffline: (offline) => setOffline(offline),
  serverPeerIds: () => [...serverPeerIds],
  serverHeads: (documentId) => serverHeads.get(documentId),
  workerErrors: () => [...workerErrors],
  workerLog: () => [...workerLog],
  remoteHeadsSeen: () => [...remoteHeadsSeen],
  // Resolves with the epoch time the server was seen holding exactly the heads
  // the document has right now. Polled: a few ms of slop is fine here.
  async serverConfirmed(url, timeoutMs = 30_000) {
    const { handle } = await find(url);
    const target = [...handle.heads()];
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const seen = serverHeads.get(handle.documentId);
      if (seen && sameHeads(seen, target)) {
        return performance.timeOrigin + performance.now();
      }
      if (performance.now() > deadline) {
        throw new Error(`server never confirmed ${url}: saw ${seen}`);
      }
      await sleep(10);
    }
  },
  stallStart() {
    if (stall) return;
    const state: Stall = {
      timer: 0 as unknown as ReturnType<typeof setInterval>,
      expected: performance.now() + STALL_INTERVAL_MS,
      maxMs: 0,
      totalMs: 0,
      longTasks: 0,
      longTaskMs: 0,
    };
    state.timer = setInterval(() => {
      const now = performance.now();
      const late = Math.max(0, now - state.expected);
      state.maxMs = Math.max(state.maxMs, late);
      state.totalMs += late;
      state.expected = now + STALL_INTERVAL_MS;
    }, STALL_INTERVAL_MS);
    if (typeof PerformanceObserver !== "undefined") {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks++;
          state.longTaskMs += entry.duration;
        }
      });
      try {
        state.observer.observe({ type: "longtask", buffered: false });
      } catch {}
    }
    stall = state;
  },
  stallStop() {
    if (!stall) return { maxMs: 0, totalMs: 0, longTasks: 0, longTaskMs: 0 };
    clearInterval(stall.timer);
    for (const entry of stall.observer?.takeRecords() ?? []) {
      stall.longTasks++;
      stall.longTaskMs += entry.duration;
    }
    stall.observer?.disconnect();
    const { maxMs, totalMs, longTasks, longTaskMs } = stall;
    stall = null;
    return { maxMs, totalMs, longTasks, longTaskMs };
  },
};

const repo = await build();
if (repo) window.repo = repo;
mark("ready");
document.body.textContent = `${mode}: ready in ${Math.round(marks.ready - marks.start)}ms`;

declare global {
  interface Window {
    repo: Repo;
    bench: {
      mode: Mode;
      storage: Storage;
      marks: Record<string, number>;
      find: typeof find;
      online: (timeoutMs?: number) => Promise<number>;
      isOnline: () => Promise<boolean>;
      setOffline: (offline: boolean) => void;
      serverPeerIds: () => string[];
      serverHeads: (documentId: string) => string[] | undefined;
      workerErrors: () => string[];
      workerLog: () => string[];
      remoteHeadsSeen: () => unknown[];
      serverConfirmed: (url: string, timeoutMs?: number) => Promise<number>;
      stallStart: () => void;
      stallStop: () => {
        maxMs: number;
        totalMs: number;
        longTasks: number;
        longTaskMs: number;
      };
    };
  }
}
