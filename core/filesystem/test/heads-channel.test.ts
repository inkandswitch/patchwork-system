import { describe, it, expect, afterEach, vi } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  documentIdToBinary,
  encodeHeads,
  Repo,
  type Chunk,
  type DocumentId,
  type PeerId,
  type RepoConfig,
  type StorageAdapterInterface,
  type StorageId,
  type StorageKey,
} from "@automerge/automerge-repo";
import { MemorySigner, SedimentreeId } from "@automerge/automerge-subduction";

interface Doc {
  text: string;
}

class SharedMemoryAdapter implements StorageAdapterInterface {
  writes: string[] = [];
  reads: string[] = [];
  failRanges = 0;
  /** Deliver a range read this long after snapshotting it. */
  rangeDelayMs = 0;
  /** Set while writes are held open, so a save can be caught in flight. */
  saveGate: Promise<void> | null = null;
  releaseSaves = () => {};

  blockSaves() {
    this.saveGate = new Promise<void>((resolve) => {
      this.releaseSaves = () => {
        this.saveGate = null;
        resolve();
      };
    });
  }

  constructor(public data = new Map<string, Uint8Array>()) {}

  async load(key: StorageKey) {
    this.reads.push(key.join("/"));
    return this.data.get(key.join("/"));
  }
  async save(key: StorageKey, data: Uint8Array) {
    if (this.saveGate) await this.saveGate;
    this.data.set(key.join("/"), data);
    this.writes.push(key.join("/"));
  }
  async remove(key: StorageKey) {
    this.data.delete(key.join("/"));
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const p = prefix.join("/");
    this.reads.push(p);
    if (this.failRanges > 0) {
      this.failRanges--;
      throw new Error("storage unavailable");
    }
    const out: Chunk[] = [];
    for (const [k, data] of this.data) {
      if (k === p || k.startsWith(p + "/")) out.push({ key: k.split("/"), data });
    }
    if (this.rangeDelayMs > 0) await pause(this.rangeDelayMs);
    return out;
  }
  async removeRange(prefix: StorageKey) {
    for (const c of await this.loadRange(prefix)) this.data.delete(c.key.join("/"));
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    if (this.saveGate) await this.saveGate;
    for (const [k, d] of entries) {
      this.data.set(k.join("/"), d);
      this.writes.push(k.join("/"));
    }
  }
}

function pause(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms: number,
  label: string
) {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms: ${label}`);
    await pause(20);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

const succeededRound = async () => ({
  entries: () => [
    { success: true, stats: { commitsReceived: 0, fragmentsReceived: 0 } },
  ],
});

const channelName = () => `test-heads-${Math.random().toString(36).slice(2)}`;

const sidOf = (storage: SharedMemoryAdapter) =>
  storage.writes.find((k) => k.startsWith("subduction/commits/"))!.split("/")[2];

const SERVER = "server" as StorageId;
const MAX_BACKSTOP_SYNCS = 3;

const bogusHead = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * A repo that reports itself connected without any real transport, so the
 * containment backstop is allowed to run. `healInitialDelayMs` is also how
 * long the backstop waits before believing a divergence, so it sets both
 * how fast the test runs and how much room there is to interrupt it.
 */
const connectedWithin = (healInitialDelayMs: number): Partial<RepoConfig> => ({
  subductionAdapters: [
    {
      adapter: {
        on() {},
        connect() {},
        state: () => ({ value: "ready", watch: async function* () {} }),
      } as never,
      serviceName: "test",
    },
  ],
  subductionTimeouts: { healInitialDelayMs, healMaxDelayMs: 40, healMaxAttempts: 2 },
});

const connected = connectedWithin(40);

/**
 * No adapter at all, so `isConnected()` is false. The containment
 * backstop opens no round here; the only thing it can still do is put a
 * sibling's commits back in this node's tree, ready for the reconnect.
 */
const offlineWithin = (healInitialDelayMs: number): Partial<RepoConfig> => ({
  subductionTimeouts: { healInitialDelayMs },
});

/** The commit heads this repo's subduction tree actually holds. */
async function treeCommits(repo: Repo, documentId: DocumentId) {
  const bytes = new Uint8Array(32);
  bytes.set(documentIdToBinary(documentId)!.subarray(0, 32));
  const commits = await (
    await repo.subduction
  ).getCommits(SedimentreeId.fromBytes(bytes));
  return (commits ?? []).map((c) => c.commitId.toHexString());
}

const commitWrites = (storage: SharedMemoryAdapter, from: number) =>
  storage.writes.slice(from).filter((k) => k.startsWith("subduction/commits/"));

const repos: Repo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

async function siblings(channel: string | undefined, extra: Partial<RepoConfig> = {}) {
  const data = new Map<string, Uint8Array>();
  const storageA = new SharedMemoryAdapter(data);
  const storageB = new SharedMemoryAdapter(data);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const mk = (storage: SharedMemoryAdapter) => {
    const signer = MemorySigner.fromBytes(secret);
    const repo = new Repo({
      storage,
      signer,
      peerId: signer.peerId().toString() as PeerId,
      network: [],
      headsChannel: channel,
      ...extra,
    });
    repos.push(repo);
    return repo;
  };
  const repoA = mk(storageA);
  const repoB = mk(storageB);
  const mkSibling = () => mk(new SharedMemoryAdapter(data));
  const syncA = vi
    .spyOn(await repoA.subduction, "syncWithAllPeers")
    .mockImplementation(succeededRound as any);
  const syncB = vi
    .spyOn(await repoB.subduction, "syncWithAllPeers")
    .mockImplementation(succeededRound as any);
  return { storageA, storageB, repoA, repoB, syncA, syncB, mkSibling };
}

async function shared(channel: string | undefined, extra: Partial<RepoConfig> = {}) {
  const s = await siblings(channel, extra);
  const a = s.repoA.create<Doc>();
  a.change((d) => {
    d.text = "one";
  });
  await s.repoA.flush();
  const b = await withTimeout(s.repoB.find<Doc>(a.url), 5000, "B finds A's doc");
  expect(b.doc().text).toBe("one");
  await pause(500);
  return { ...s, a, b };
}

describe("subduction heads channel", () => {
  it("a sibling's change arrives through the channel: no server round, nothing written back", async () => {
    const { storageB, repoA, repoB, syncA, syncB, a, b } = await shared(channelName());

    const roundsA = syncA.mock.calls.length;
    const roundsB = syncB.mock.calls.length;
    const writeMark = storageB.writes.length;

    a.change((d) => {
      d.text = "two";
    });
    await until(() => b.doc().text === "two", 5000, "B sees A's change");
    await pause(500);

    expect(syncB.mock.calls.length).toBe(roundsB);
    expect(syncA.mock.calls.length).toBeGreaterThan(roundsA);
    expect(
      storageB.writes.slice(writeMark).filter((k) => k.startsWith("subduction/"))
    ).toEqual([]);

    const roundsA2 = syncA.mock.calls.length;
    const roundsB2 = syncB.mock.calls.length;

    b.change((d) => {
      d.text = "three";
    });
    await until(() => a.doc().text === "three", 5000, "A sees B's change");
    await pause(500);

    expect(syncA.mock.calls.length).toBe(roundsA2);
    expect(syncB.mock.calls.length).toBeGreaterThan(roundsB2);
    void repoA;
    void repoB;
  });

  it("without a channel the sibling keeps its stale view", async () => {
    const { repoA, a, b } = await shared(undefined);

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(1000);
    expect(b.doc().text).toBe("one");
  });

  it("an announcement for a doc this node never attached reads nothing", async () => {
    const { storageA, storageB, repoA } = await siblings(channelName());

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const sid = sidOf(storageA);
    const readMark = storageB.reads.length;

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(500);

    expect(storageB.reads.slice(readMark).filter((k) => k.includes(sid))).toEqual([]);
  });

  it("an announcement of heads this node already knows reads nothing", async () => {
    const name = channelName();
    const { storageA, storageB, b } = await shared(name);
    const sid = sidOf(storageA);
    const readMark = storageB.reads.length;

    const announcer = new BroadcastChannel(name);
    announcer.postMessage({
      kind: "saved",
      sid,
      heads: Automerge.getHeads(b.doc()),
    });
    await pause(500);
    announcer.close();

    expect(storageB.reads.slice(readMark).filter((k) => k.includes(sid))).toEqual([]);
  });

  it("a detached doc shows a sibling's later change when found again", async () => {
    const { repoA, repoB, a } = await shared(channelName());
    await repoB.removeFromCache(a.documentId);

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(500);

    const again = await withTimeout(
      repoB.find<Doc>(a.url),
      5000,
      "B finds A's doc again"
    );
    await until(
      () => again.doc().text === "two",
      5000,
      "B's re-found handle shows A's change"
    );
  });

  it("a reload whose storage read fails once still converges without a server", async () => {
    const { storageB, syncB, a, b } = await shared(channelName());
    const roundsB = syncB.mock.calls.length;
    const readMark = storageB.reads.length;
    storageB.failRanges = 6;

    a.change((d) => {
      d.text = "two";
    });
    await until(() => b.doc().text === "two", 5000, "B converges after a failed read");
    await pause(300);

    expect(storageB.failRanges).toBe(0);
    expect(storageB.reads.length - readMark).toBeGreaterThan(6);
    expect(syncB.mock.calls.length).toBe(roundsB);
  });

  it("a reload whose storage keeps failing stops after a few tries and says so once", async () => {
    const { storageB, repoA, syncB, a, b } = await shared(channelName());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const roundsB = syncB.mock.calls.length;
    const readMark = storageB.reads.length;
    storageB.failRanges = Infinity;

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(1500);
    const readsAfter = storageB.reads.length;
    await pause(500);

    expect(storageB.reads.length).toBe(readsAfter);
    const attempts = storageB.reads
      .slice(readMark)
      .filter((k) => k.startsWith("subduction/fragment-blobs/")).length;
    expect(attempts).toBe(4);
    expect(syncB.mock.calls.length).toBe(roundsB);
    expect(b.doc().text).toBe("one");
    const said = warn.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes("reload from storage failed")
      )
    );
    expect(said).toHaveLength(1);
    warn.mockRestore();
    storageB.failRanges = 0;
  });

  it("a sibling's word about the server lands without a round of our own", async () => {
    const name = channelName();
    const { storageA, syncA, syncB, a, b } = await shared(name);
    const sid = sidOf(storageA);
    const heads = encodeHeads(Automerge.getHeads(a.doc()));
    const roundsA = syncA.mock.calls.length;
    const roundsB = syncB.mock.calls.length;

    const announcer = new BroadcastChannel(name);
    announcer.postMessage({
      kind: "remote",
      sid,
      storageId: SERVER,
      heads,
      timestamp: Date.now(),
    });
    await pause(400);
    announcer.close();

    expect(a.getSyncInfo(SERVER)?.lastHeads).toEqual(heads);
    expect(b.getSyncInfo(SERVER)?.lastHeads).toEqual(heads);
    expect(syncA.mock.calls.length).toBe(roundsA);
    expect(syncB.mock.calls.length).toBe(roundsB);
  });

  it("an older observation does not walk the view of the server backwards", async () => {
    const name = channelName();
    const { storageA, repoA, a } = await shared(name);
    const sid = sidOf(storageA);
    const older = encodeHeads(Automerge.getHeads(a.doc()));
    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    const newer = encodeHeads(Automerge.getHeads(a.doc()));
    expect(newer).not.toEqual(older);

    const surfaced: string[][] = [];
    a.on("remote-heads", ({ heads }) => surfaced.push([...heads]));

    const now = Date.now();
    const announcer = new BroadcastChannel(name);
    const say = (heads: string[], timestamp: number) =>
      announcer.postMessage({
        kind: "remote",
        sid,
        storageId: SERVER,
        heads,
        timestamp,
      });

    say(newer, now);
    await pause(250);
    say(older, now - 5000);
    await pause(250);
    say(newer, now + 5000);
    await pause(250);
    announcer.close();

    expect(a.getSyncInfo(SERVER)?.lastHeads).toEqual(newer);
    expect(surfaced).toEqual([newer]);
  });

  it("a relayed observation is not relayed again", async () => {
    const name = channelName();
    const { storageA, a } = await shared(name);
    const sid = sidOf(storageA);
    const heads = encodeHeads(Automerge.getHeads(a.doc()));

    const heard: Array<{ kind?: string }> = [];
    const listener = new BroadcastChannel(name);
    listener.onmessage = ({ data }) => heard.push(data);

    const announcer = new BroadcastChannel(name);
    const message = {
      kind: "remote",
      sid,
      storageId: SERVER,
      heads,
      timestamp: Date.now(),
    };
    announcer.postMessage(message);
    await pause(400);
    announcer.close();
    listener.close();

    expect(heard.filter((m) => m.kind === "remote")).toHaveLength(1);
  });

  it("the backstop gives up once no round could catch the server up", async () => {
    const name = channelName();
    const { storageA, syncA, a, b } = await shared(name, connected);
    const sid = sidOf(storageA);
    const announcer = new BroadcastChannel(name);
    const nudge = () =>
      announcer.postMessage({ kind: "saved", sid, heads: [bogusHead()] });

    // Tell both tabs the server holds everything they hold, then walk a
    // recompute past it so the backstop budget is known to be untouched.
    announcer.postMessage({
      kind: "remote",
      sid,
      storageId: SERVER,
      heads: encodeHeads(Automerge.getHeads(a.doc())),
      timestamp: Date.now(),
    });
    nudge();
    await pause(400);
    const mark = syncA.mock.calls.length;

    // B's commit reaches A's handle by way of the shared database, so A
    // holds a hash it will never push: nothing A can do makes the server's
    // known heads contain A's.
    b.change((d) => {
      d.text = "from b";
    });
    await until(() => a.doc().text === "from b", 5000, "A sees B's change");

    const opened = () => syncA.mock.calls.length - mark;
    const deadline = Date.now() + 15_000;
    while (opened() < MAX_BACKSTOP_SYNCS && Date.now() < deadline) {
      nudge();
      await pause(150);
    }
    expect(opened()).toBe(MAX_BACKSTOP_SYNCS);

    for (let i = 0; i < 6; i++) {
      nudge();
      await pause(150);
    }
    await pause(600);
    announcer.close();

    expect(opened()).toBe(MAX_BACKSTOP_SYNCS);
  });

  it("a sibling's word about the server keeps the backstop quiet", async () => {
    const name = channelName();
    const { storageA, syncA, a } = await shared(name, connected);
    const sid = sidOf(storageA);
    const announcer = new BroadcastChannel(name);

    announcer.postMessage({
      kind: "remote",
      sid,
      storageId: SERVER,
      heads: encodeHeads(Automerge.getHeads(a.doc())),
      timestamp: Date.now(),
    });
    await pause(300);
    const mark = syncA.mock.calls.length;

    for (let i = 0; i < 6; i++) {
      announcer.postMessage({ kind: "saved", sid, heads: [bogusHead()] });
      await pause(150);
    }
    await pause(400);
    announcer.close();

    expect(syncA.mock.calls.length).toBe(mark);
  });

  it("a sibling's word arriving during the wait costs no round and no write", async () => {
    const name = channelName();
    const { storageA, syncA, a, b } = await shared(name, connectedWithin(600));
    const sid = sidOf(storageA);
    const announcer = new BroadcastChannel(name);
    const serverHolds = (handle: { doc(): Doc }) =>
      announcer.postMessage({
        kind: "remote",
        sid,
        storageId: SERVER,
        heads: encodeHeads(Automerge.getHeads(handle.doc())),
        timestamp: Date.now(),
      });

    serverHolds(a);
    announcer.postMessage({ kind: "saved", sid, heads: [bogusHead()] });
    await pause(900);
    const mark = syncA.mock.calls.length;
    const writeMark = storageA.writes.length;

    b.change((d) => {
      d.text = "from b";
    });
    await until(() => a.doc().text === "from b", 5000, "A sees B's change");
    // Within the backstop's window: the server has it after all.
    serverHolds(b);
    await pause(1500);
    announcer.close();

    expect(syncA.mock.calls.length).toBe(mark);
    expect(commitWrites(storageA, writeMark)).toEqual([]);
  });

  it("offline, a sibling's commit is written again so this tab can push it", async () => {
    const { storageA, storageB, repoA, syncA, a, b } = await shared(
      channelName(),
      offlineWithin(300)
    );
    const sid = sidOf(storageA);
    const rounds = syncA.mock.calls.length;
    const writeMark = storageA.writes.length;

    b.change((d) => {
      d.text = "from b";
    });
    await until(() => a.doc().text === "from b", 5000, "A sees B's change");
    const hash = Automerge.getHeads(b.doc())[0];
    const bCommit = `subduction/commits/${sid}/${hash}`;
    expect(storageB.writes).toContain(bCommit);

    // The reload put B's commit in A's handle and in A's knownHashes, but
    // not in A's tree: as it stands A can never push it.
    expect(await treeCommits(repoA, a.documentId)).not.toContain(hash);
    expect(commitWrites(storageA, writeMark)).toEqual([]);

    // Settled, still diverged, and no round to fix it: re-ingest.
    await until(
      async () => (await treeCommits(repoA, a.documentId)).includes(hash),
      5000,
      "A's tree gains B's commit"
    );
    expect(commitWrites(storageA, writeMark)).toEqual([bCommit]);

    // Once. The set that named it is empty now and nothing refills it.
    await pause(1200);
    expect(commitWrites(storageA, writeMark)).toEqual([bCommit]);
    // The backstop opened no round: the one round here is the one the
    // save itself arms, the same one a local edit would have armed.
    expect(syncA.mock.calls.length).toBe(rounds + 1);
  });

  it("the re-ingest happens once even when no round ever confirms it", async () => {
    const name = channelName();
    const { storageA, syncA, a, b } = await shared(name, connected);
    const sid = sidOf(storageA);
    const announcer = new BroadcastChannel(name);
    const nudge = () =>
      announcer.postMessage({ kind: "saved", sid, heads: [bogusHead()] });

    announcer.postMessage({
      kind: "remote",
      sid,
      storageId: SERVER,
      heads: encodeHeads(Automerge.getHeads(a.doc())),
      timestamp: Date.now(),
    });
    nudge();
    await pause(400);
    const rounds = syncA.mock.calls.length;
    const writeMark = storageA.writes.length;

    // `syncA` is a mock: it reports success and never tells A the server
    // took anything, so containment is never observed however many rounds
    // run. The write must not follow the rounds.
    b.change((d) => {
      d.text = "from b";
    });
    await until(() => a.doc().text === "from b", 5000, "A sees B's change");
    for (let i = 0; i < 10; i++) {
      nudge();
      await pause(150);
    }
    await pause(600);
    announcer.close();

    expect(commitWrites(storageA, writeMark)).toHaveLength(1);
    expect(syncA.mock.calls.length).toBeGreaterThan(rounds);
  });

  it("a save in flight when the backstop fires does not swallow the re-ingest", async () => {
    const { storageA, repoA, a, b } = await shared(
      channelName(),
      offlineWithin(2000)
    );

    b.change((d) => {
      d.text = "from b";
    });
    await until(() => a.doc().text === "from b", 5000, "A sees B's change");
    const hash = Automerge.getHeads(b.doc())[0];
    expect(await treeCommits(repoA, a.documentId)).not.toContain(hash);

    // A's own write is held open across the backstop's expiry. That save
    // restores the save baseline as it finishes, so a re-ingest that
    // cleared the baseline before waiting for it would find its own save
    // returning on `#save`'s heads fast path, having stored nothing.
    storageA.blockSaves();
    a.change((d) => {
      d.text = "from b, and a";
    });
    await pause(2500);
    storageA.releaseSaves();

    await until(
      async () => (await treeCommits(repoA, a.documentId)).includes(hash),
      8000,
      "A's tree gains B's commit with a save already in flight"
    );
  });

  it("an announcement arriving during a reload is not lost with it", async () => {
    const { storageA, repoA, a, b } = await shared(
      channelName(),
      offlineWithin(300)
    );
    // The read snapshots and then takes its time, so B's second
    // announcement lands while the first reload is still in flight.
    storageA.rangeDelayMs = 500;

    b.change((d) => {
      d.text = "one from b";
    });
    const first = Automerge.getHeads(b.doc())[0];
    await pause(250);
    b.change((d) => {
      d.text = "two from b";
    });
    const second = Automerge.getHeads(b.doc())[0];
    expect(second).not.toBe(first);

    await until(
      () => a.doc().text === "two from b",
      8000,
      "A sees both of B's changes"
    );
    // The second announcement was set while the first reload was running.
    // Cleared by that reload, it would come back as an ordinary load and
    // file B's second commit as known and not stranded — unpushable, and
    // invisible to the re-ingest.
    await until(
      async () => {
        const tree = await treeCommits(repoA, a.documentId);
        return tree.includes(first) && tree.includes(second);
      },
      8000,
      "A's tree gains both of B's commits"
    );
    storageA.rangeDelayMs = 0;
  });

  it("the re-ingest's announcement dies with three tabs listening", async () => {
    const name = channelName();
    const { repoA, repoB, mkSibling, a, b } = await shared(
      name,
      offlineWithin(300)
    );
    const repoC = mkSibling();
    vi.spyOn(await repoC.subduction, "syncWithAllPeers").mockImplementation(
      succeededRound as never
    );
    const c = await withTimeout(repoC.find<Doc>(a.url), 5000, "C finds the doc");
    await pause(500);

    const heard: Array<{ kind?: string }> = [];
    const listener = new BroadcastChannel(name);
    listener.onmessage = ({ data }) => heard.push(data);

    b.change((d) => {
      d.text = "from b";
    });
    await until(
      () => a.doc().text === "from b" && c.doc().text === "from b",
      5000,
      "A and C see B's change"
    );
    await pause(2000);
    listener.close();

    // B's own save, then one re-ingest each from A and C. Each of those
    // announces heads the other two already hold, so neither reloads and
    // nothing announces again.
    expect(heard.filter((m) => m.kind === "saved")).toHaveLength(3);
    const hash = Automerge.getHeads(b.doc())[0];
    for (const [repo, label] of [
      [repoA, "A"],
      [repoB, "B"],
      [repoC, "C"],
    ] as const) {
      expect(await treeCommits(repo, a.documentId), label).toContain(hash);
    }
  });

  it("nothing is posted on the channel after shutdown closes it", async () => {
    const closed = new WeakSet<BroadcastChannel>();
    const afterClose: unknown[] = [];
    const realClose = BroadcastChannel.prototype.close;
    const realPost = BroadcastChannel.prototype.postMessage;
    vi.spyOn(BroadcastChannel.prototype, "close").mockImplementation(
      function (this: BroadcastChannel) {
        closed.add(this);
        return realClose.call(this);
      }
    );
    vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation(
      function (this: BroadcastChannel, message: unknown) {
        if (closed.has(this)) afterClose.push(message);
        return realPost.call(this, message);
      }
    );

    try {
      const { repoA, a } = await shared(channelName());
      const done = repoA.shutdown();
      a.change((d) => {
        d.text = "after the flush";
      });
      await done;
      await pause(400);
      expect(afterClose).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("each source unrefs its channel so it does not keep a Node process alive", async () => {
    const unref = vi.spyOn(
      BroadcastChannel.prototype as unknown as { unref(): void },
      "unref"
    );
    await siblings(channelName());
    expect(unref).toHaveBeenCalledTimes(2);
    unref.mockRestore();
  });
});
