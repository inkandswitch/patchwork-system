// A page that builds one Repo in one of three topologies and exposes enough
// for the playwright specs in ../tests to time it. No UI, no account, no
// package list: the shell is out of scope here.
//
//   ?mode=shared     this branch: storageless tab hanging off the subduction
//                    SharedWorker, which owns storage and the server socket
//   ?mode=pertab     no shared workers: a full subduction node in the tab with
//                    its own socket, all tabs writing the same IndexedDB
//   ?mode=pertab-bc  pertab, plus classic automerge sync between tabs over a
//                    BroadcastChannel so siblings don't wait on the server echo
//
// `?server=none` runs the per-tab modes with no socket at all, so tabs can
// only meet through IndexedDB (and the BroadcastChannel).
import {
  Repo,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type PeerId,
} from "@automerge/automerge-repo/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
import { createRepo, initWasm } from "@inkandswitch/patchwork";
import setupServiceWorker from "@inkandswitch/patchwork-bootloader";
import { SYNCSTATE_CHANNEL } from "@inkandswitch/patchwork-bootloader/types";

declare const __SYNC_SERVER__: { url: string };

type Mode = "shared" | "pertab" | "pertab-bc";

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "shared") as Mode;
const serverUrl = params.get("server") ?? __SYNC_SERVER__.url;

const marks: Record<string, number> = {};
const mark = (name: string) => (marks[name] = performance.now());

// Server heads per document, however this topology learns them.
const serverHeads = new Map<string, string[]>();
let serverPeerIds = new Set<string>();
let online = Promise.withResolvers<number>();

function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}

async function build(): Promise<Repo> {
  mark("start");
  await initWasm();
  mark("wasm");

  if (mode === "shared") {
    const sw = await setupServiceWorker();
    if (!sw) throw new Error("no service worker");
    mark("workers");
    const { repo } = await createRepo(sw);
    mark("repo");

    const channel = new BroadcastChannel(SYNCSTATE_CHANNEL);
    channel.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type !== "connection") return;
      serverPeerIds = new Set(data.serverPeerIds);
      if (data.connected) online.resolve(performance.now());
    });
    channel.postMessage({ type: "request" });

    const watched = new Set<string>();
    window.bench.watch = (documentId) => {
      if (watched.has(documentId)) return;
      watched.add(documentId);
      sw.subscribeSyncState(documentId, (update) => {
        if (!serverPeerIds.has(update.storageId)) return;
        serverHeads.set(documentId, update.heads);
      });
    };
    return repo;
  }

  const repo = new Repo({
    signer: new MemorySigner(),
    storage: new IndexedDBWorkerStorageAdapter(),
    peerId: `bench-tab-${crypto.randomUUID()}` as PeerId,
    subductionWebsocketEndpoints: serverUrl === "none" ? [] : [serverUrl],
    network:
      mode === "pertab-bc"
        ? [new BroadcastChannelNetworkAdapter({ channelName: "bench" })]
        : [],
    async sharePolicy() {
      return true;
    },
  });
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
  watch: () => {},
  online: () => online.promise,
  serverPeerIds: () => [...serverPeerIds],
  serverHeads: (documentId) => serverHeads.get(documentId),
  // Resolves with the epoch time the server was seen holding exactly the heads
  // the document has right now. Polled: a few ms of slop is fine here.
  async serverConfirmed(url, timeoutMs = 30_000) {
    const { handle } = await find(url);
    const target = [...handle.heads()];
    window.bench.watch(handle.documentId);
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
      watch: (documentId: DocumentId) => void;
      online: () => Promise<number>;
      serverPeerIds: () => string[];
      serverHeads: (documentId: string) => string[] | undefined;
      serverConfirmed: (url: string, timeoutMs?: number) => Promise<number>;
    };
  }
}
