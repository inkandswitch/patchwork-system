// A page that builds one Repo in one of three topologies and exposes enough
// for the playwright specs in ../tests to time it. No UI, no account, no
// package list: the shell is out of scope here.
//
//   ?mode=patchwork  what patchwork does: createRepo() — the tab's own
//                    subduction node with this origin's IndexedDB, its own
//                    server socket and the siblings BroadcastChannel — plus
//                    the automerge worker that resolves URLs for the service
//                    worker
//   ?mode=pertab     the bare node: storage + socket, no siblings channel, no
//                    workers, so tabs only meet through the server (or the
//                    database)
//   ?mode=pertab-bc  pertab plus the siblings channel, hand-rolled
//
// `?server=none` runs the bare modes with no socket at all, so tabs can only
// meet through IndexedDB (and the BroadcastChannel).
import {
  Repo,
  type AutomergeUrl,
  type DocHandle,
  type PeerId,
} from "@automerge/automerge-repo/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
import { createRepo, initWasm } from "@inkandswitch/patchwork";
import setupServiceWorker from "@inkandswitch/patchwork-bootloader";

declare const __SYNC_SERVER__: { url: string };

type Mode = "patchwork" | "pertab" | "pertab-bc";

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "patchwork") as Mode;
const serverUrl = params.get("server") ?? __SYNC_SERVER__.url;

const marks: Record<string, number> = {};
const mark = (name: string) => (marks[name] = performance.now());

const serverHeads = new Map<string, string[]>();
let serverPeerIds = new Set<string>();
const online = Promise.withResolvers<number>();

function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}

async function build(): Promise<Repo> {
  mark("start");
  await initWasm();
  mark("wasm");

  let repo: Repo;
  if (mode === "patchwork") {
    const sw = await setupServiceWorker();
    if (!sw) throw new Error("no service worker");
    mark("workers");
    ({ repo } = await createRepo());
  } else {
    repo = new Repo({
      signer: new MemorySigner(),
      storage: new IndexedDBWorkerStorageAdapter(),
      peerId: `bench-tab-${crypto.randomUUID()}` as PeerId,
      subductionWebsocketEndpoints: serverUrl === "none" ? [] : [serverUrl],
      network:
        mode === "pertab-bc"
          ? [new BroadcastChannelNetworkAdapter({ channelName: "bench" })]
          : [],
      enableRemoteHeadsGossiping: true,
    });
  }
  mark("repo");

  if (serverUrl === "none") online.resolve(performance.now());
  repo.on("subduction-connection", async ({ connected }) => {
    if (!connected) return;
    serverPeerIds = new Set(await repo.connectedSubductionPeerIds());
    online.resolve(performance.now());
  });
  repo.on("subduction-remote-heads", ({ documentId, storageId, heads }) => {
    if (!serverPeerIds.has(storageId)) return;
    serverHeads.set(documentId, [...heads]);
  });
  return repo;
}

// `find` settles as unavailable when every source has said no, and a sibling
// tab's brand-new doc may not have reached those sources yet. Retrying is what
// an app would have to do; the attempt count is reported so the benches can
// say how often it was needed.
async function find(
  url: string,
  timeoutMs = 30_000
): Promise<{ handle: DocHandle<Record<string, unknown>>; attempts: number }> {
  const deadline = performance.now() + timeoutMs;
  for (let attempts = 1; ; attempts++) {
    try {
      const handle = await window.repo.find<Record<string, unknown>>(
        url as AutomergeUrl
      );
      await handle.whenReady();
      return { handle, attempts };
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

window.bench = {
  mode,
  marks,
  find,
  online: () => online.promise,
  serverPeerIds: () => [...serverPeerIds],
  serverHeads: (documentId) => serverHeads.get(documentId),
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  },
};

window.repo = await build();
mark("ready");
document.body.textContent = `${mode}: ready in ${Math.round(marks.ready - marks.start)}ms`;

declare global {
  interface Window {
    repo: Repo;
    bench: {
      mode: Mode;
      marks: Record<string, number>;
      find: typeof find;
      online: () => Promise<number>;
      serverPeerIds: () => string[];
      serverHeads: (documentId: string) => string[] | undefined;
      serverConfirmed: (url: string, timeoutMs?: number) => Promise<number>;
    };
  }
}
