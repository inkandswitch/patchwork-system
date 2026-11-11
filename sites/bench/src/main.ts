// The page at `/` builds Patchwork's tab Repo, createRepo() as shipped, and
// nothing else: no shell, no account, no package list. The modes and query
// params are in ../README.md.
import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo/slim";
import { createRepo, initWasm } from "@inkandswitch/patchwork";
import setupServiceWorker, {
  type PortBackend,
} from "@inkandswitch/patchwork-bootloader";

const params = new URLSearchParams(location.search);
const mode = "patchwork";
const stop = params.get("stop");

const marks: Record<string, number> = {};
const mark = (name: string) => (marks[name] ??= performance.now());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The sync server's heads for each document, as the automerge worker relays
// them: what `handle.heads()` is compared with, as UrlHeads.
const serverHeads = new Map<string, string[]>();
// When the server was first seen listing each head of each document, as epoch
// ms, so serverConfirmed reports the event rather than when it polled.
const serverHeadSeenAt = new Map<string, Map<string, number>>();
function noteServerHeads(documentId: string, heads: string[]) {
  const previous = serverHeads.get(documentId);
  if (previous && sameHeads(previous, heads)) return;
  serverHeads.set(documentId, heads);
  const now = performance.timeOrigin + performance.now();
  let seenAt = serverHeadSeenAt.get(documentId);
  if (!seenAt) serverHeadSeenAt.set(documentId, (seenAt = new Map()));
  for (const head of heads) if (!seenAt.has(head)) seenAt.set(head, now);
}
function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}

let serverPeerIds = new Set<string>();
const online = Promise.withResolvers<number>();
let backend: PortBackend | undefined;

async function build(): Promise<typeof window.repo | null> {
  mark("start");
  if (stop === "js") return null;
  await initWasm();
  mark("wasm");
  if (stop === "wasm") return null;
  const sw = await setupServiceWorker();
  if (!sw) throw new Error("no service worker");
  mark("workers");
  const tab = await createRepo();
  backend = tab.backend;
  mark("repo");

  // The Repo's backend is a port to the automerge worker, which is the one
  // node on this origin and holds the only socket, so the worker's link is
  // the server link. Its peers are the sync server.
  const up = async () => {
    const at = performance.now();
    serverPeerIds = new Set(await tab.backend.serverPeers());
    online.resolve(at);
  };
  tab.backend.onServerStatus((connected) => {
    if (connected) void up();
  });
  if (tab.backend.serverConnected) void up();

  // Every document the Repo opens: what the server says it has.
  tab.repo.on("document", ({ handle }) => {
    handle.on("remote-heads", ({ peerId, heads }) => {
      if (serverPeerIds.size && !serverPeerIds.has(peerId)) return;
      noteServerHeads(handle.documentId, [...heads]);
    });
  });
  return tab.repo;
}

// `find` settles as unavailable when every source has said no, and a sibling
// tab's brand-new doc may not have reached those sources yet, so it's tried
// again; the attempt count is reported so the benches can say how often it was
// needed. The deadline also bounds a find that stays pending.
async function find(
  url: string,
  timeoutMs = 30_000
): Promise<{ handle: DocHandle<Record<string, unknown>>; attempts: number }> {
  const deadline = performance.now() + timeoutMs;
  parseAutomergeUrl(url as AutomergeUrl);
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
      return { handle, attempts };
    } catch (error) {
      if (performance.now() > deadline) throw error;
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
  marks,
  find,
  online: (timeoutMs = ONLINE_TIMEOUT_MS) =>
    Promise.race([
      online.promise,
      sleep(timeoutMs).then(() => {
        throw new Error(`server not connected within ${timeoutMs}ms`);
      }),
    ]),
  isOnline: async () => backend?.serverConnected ?? false,
  // The automerge worker's socket is out of reach of Playwright's offline
  // switch, so the worker is asked to drop it and fail its reconnects.
  setOffline: (offline) => {
    void backend?.setOffline(offline);
  },
  serverPeerIds: () => [...serverPeerIds],
  serverHeads: (documentId) => serverHeads.get(documentId),
  // Not measurable from a tab: the server socket, the IndexedDB writes and the
  // sync rounds all live in the automerge worker, which reports no counters.
  serverBytes: () => null,
  storageWrites: () => null,
  syncRounds: () => null,
  // Resolves with the epoch time the server was seen listing every head the
  // document has right now: when the heads event carrying the last of them
  // arrived (noteServerHeads), even if that was before this was called.
  // Polled only to wait for it.
  //
  // Every one of ours among the server's heads, not the two sets equal: once
  // a document's history reaches a fragment boundary (a commit id with a
  // leading zero byte, about one commit in 256), subduction's server goes on
  // listing the commit before the boundary as a head beside the real one,
  // for good. It holds everything; the extra head is one of ours from
  // further back, which the failure message below calls "n back".
  async serverConfirmed(url, timeoutMs = 30_000) {
    const { handle } = await find(url);
    const target: string[] = [...handle.heads()];
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const seen = serverHeads.get(handle.documentId);
      if (seen && target.every((head) => seen.includes(head))) {
        const seenAt = serverHeadSeenAt.get(handle.documentId)!;
        return Math.max(...target.map((head) => seenAt.get(head)!));
      }
      if (performance.now() > deadline) {
        // Each server head the tab didn't ask about, placed in the tab's own
        // history: n back from its newest change, or a change it never got.
        const history: string[] = handle.history().map(([head]) => head);
        const placed = (seen ?? [])
          .filter((head) => !target.includes(head))
          .map((head) => {
            const at = history.indexOf(head);
            return at < 0
              ? `${head} unknown to the tab`
              : `${head} the tab's change ${history.length - 1 - at} back`;
          });
        throw new Error(
          `server never confirmed ${url}: it holds heads ${seen ?? "none"}, the tab ${target}` +
            (placed.length ? ` (${placed.join("; ")})` : "") +
            `; the tab now ${handle.heads()}`
        );
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
// `?open=<automerge url>`: what a tab opened on a document does first. Marks
// `doc` (from navigation start) once the document is in hand.
if (repo && params.has("open")) {
  void find(params.get("open")!).then(
    ({ attempts }) => {
      mark("doc");
      marks.docAttempts = attempts;
    },
    (error) => console.error("[open]", error)
  );
}
if (params.has("ui")) await import("./playground.js");

declare global {
  interface Window {
    repo: import("@automerge/automerge-repo/slim").Repo;
    bench: {
      mode: "patchwork";
      marks: Record<string, number>;
      find: typeof find;
      online: (timeoutMs?: number) => Promise<number>;
      isOnline: () => Promise<boolean>;
      setOffline: (offline: boolean) => void;
      serverPeerIds: () => string[];
      serverHeads: (documentId: string) => string[] | undefined;
      serverBytes: () => number | null;
      storageWrites: () => number | null;
      syncRounds: () => number | null;
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
