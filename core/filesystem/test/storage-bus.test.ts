import { describe, it, expect, afterEach, vi } from "vitest";
import {
  Repo,
  type Chunk,
  type PeerId,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";

interface Doc {
  text: string;
}

class SharedMemoryAdapter implements StorageAdapterInterface {
  writes: string[] = [];
  reads: string[] = [];
  rangeDelayMs = 0;

  constructor(public data = new Map<string, Uint8Array>()) {}

  async load(key: StorageKey) {
    this.reads.push(key.join("/"));
    return this.data.get(key.join("/"));
  }
  async save(key: StorageKey, data: Uint8Array) {
    this.data.set(key.join("/"), data);
    this.writes.push(key.join("/"));
  }
  async remove(key: StorageKey) {
    this.data.delete(key.join("/"));
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const p = prefix.join("/");
    this.reads.push(p);
    const out: Chunk[] = [];
    for (const [k, data] of this.data) {
      if (k === p || k.startsWith(p + "/")) out.push({ key: k.split("/"), data });
    }
    if (this.rangeDelayMs) await pause(this.rangeDelayMs);
    return out;
  }
  async removeRange(prefix: StorageKey) {
    for (const c of await this.loadRange(prefix)) this.data.delete(c.key.join("/"));
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [k, d] of entries) await this.save(k, d);
  }
}

function pause(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!cond()) {
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

const repos: Repo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

async function siblings(channel: string | undefined) {
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
      subductionStorageChannel: channel,
    });
    repos.push(repo);
    return repo;
  };
  const repoA = mk(storageA);
  const repoB = mk(storageB);
  const syncA = vi
    .spyOn(await repoA.subduction, "syncWithAllPeers")
    .mockImplementation(succeededRound as any);
  const syncB = vi
    .spyOn(await repoB.subduction, "syncWithAllPeers")
    .mockImplementation(succeededRound as any);
  return { storageA, storageB, repoA, repoB, syncA, syncB };
}

describe("subduction storage bus", () => {
  it("siblings with one signer and one storage converge over the bus, and ingestion opens no sync round", async () => {
    const { storageA, storageB, repoA, repoB, syncA, syncB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();

    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    expect(b.doc().text).toBe("one");
    await pause(500);

    const roundsA = syncA.mock.calls.length;
    const roundsB = syncB.mock.calls.length;
    const writeMarkA = storageA.writes.length;
    const writeMarkB = storageB.writes.length;

    a.change((d) => {
      d.text = "two";
    });
    await until(() => b.doc().text === "two", 5000, "B sees A's change over the bus");
    await pause(500);

    expect(syncB.mock.calls.length).toBe(roundsB);
    expect(syncA.mock.calls.length).toBeGreaterThan(roundsA);

    const commitWrites = [
      ...storageA.writes.slice(writeMarkA),
      ...storageB.writes.slice(writeMarkB),
    ].filter((k) => k.startsWith("subduction/commits/"));
    expect(commitWrites.length).toBeGreaterThan(0);
    expect(new Set(commitWrites).size).toBe(commitWrites.length);

    const roundsA2 = syncA.mock.calls.length;
    const roundsB2 = syncB.mock.calls.length;

    b.change((d) => {
      d.text = "three";
    });
    await until(() => a.doc().text === "three", 5000, "A sees B's change over the bus");
    await pause(500);

    expect(syncA.mock.calls.length).toBe(roundsA2);
    expect(syncB.mock.calls.length).toBeGreaterThan(roundsB2);
  });

  it("without a channel the sibling keeps its stale view", async () => {
    const { repoA, repoB } = await siblings(undefined);

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    await pause(300);

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(1000);
    expect(b.doc().text).toBe("one");
  });

  it("a burst of edits converges, including any fragments automerge forms", async () => {
    const { storageA, storageB, repoA, repoB, syncB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "";
    });
    await repoA.flush();
    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    await pause(500);
    const roundsB = syncB.mock.calls.length;

    for (let i = 0; i < 300; i++) {
      a.change((d) => {
        d.text += "x";
      });
      if (i % 50 === 49) await pause(150);
    }
    await repoA.flush();
    await until(
      () => b.doc().text.length === 300,
      10000,
      "B converges after a burst"
    );
    await pause(500);
    expect(syncB.mock.calls.length).toBe(roundsB);

    const fragments = [...storageA.writes, ...storageB.writes].filter((k) =>
      k.startsWith("subduction/fragments/")
    );
    console.log(`fragment records written during burst: ${fragments.length}`);
  });

  it("an announce for a doc this node never attached is ignored", async () => {
    const { storageA, storageB, repoA, repoB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );
    const storeB = vi.spyOn(await repoB.subduction, "storeBuiltBatch");

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const sid = storageA.writes
      .find((k) => k.startsWith("subduction/commits/"))!
      .split("/")[2];

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(500);

    expect(storeB).not.toHaveBeenCalled();
    expect(storageB.reads.filter((k) => k.includes(sid))).toEqual([]);
  });

  it("ingesting a sibling's records writes nothing back to storage", async () => {
    const { storageB, repoA, repoB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    await pause(500);
    const writeMark = storageB.writes.length;

    a.change((d) => {
      d.text = "two";
    });
    await until(() => b.doc().text === "two", 5000, "B sees A's change over the bus");
    await pause(500);
    expect(
      storageB.writes.slice(writeMark).filter((k) => k.startsWith("subduction/"))
    ).toEqual([]);
  });

  it("a detached doc shows a sibling's later change when found again", async () => {
    const { repoA, repoB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    expect(b.doc().text).toBe("one");
    await pause(300);
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

  it("a commit announced while the first local load is reading storage still reaches the handle", async () => {
    const { storageB, repoA, repoB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );
    storageB.rangeDelayMs = 400;

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();

    const finding = repoB.find<Doc>(a.url);
    await pause(100);
    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();

    const b = await withTimeout(finding, 5000, "B finds A's doc");
    await until(() => b.doc().text === "two", 3000, "B applies the commit announced mid-load");

    a.change((d) => {
      d.text = "three";
    });
    await repoA.flush();
    await until(() => b.doc().text === "three", 3000, "B follows A after the race");
  });

  it("a detached doc stops ingesting sibling writes", async () => {
    const { storageA, storageB, repoA, repoB } = await siblings(
      `test-bus-${Math.random().toString(36).slice(2)}`
    );
    const storeB = vi.spyOn(await repoB.subduction, "storeBuiltBatch");

    const a = repoA.create<Doc>();
    a.change((d) => {
      d.text = "one";
    });
    await repoA.flush();
    const sid = storageA.writes
      .find((k) => k.startsWith("subduction/commits/"))!
      .split("/")[2];
    const b = await withTimeout(repoB.find<Doc>(a.url), 5000, "B finds A's doc");
    expect(b.doc().text).toBe("one");
    await pause(300);
    await repoB.removeFromCache(a.documentId);
    await pause(200);
    const storeMark = storeB.mock.calls.length;
    const readMark = storageB.reads.length;

    a.change((d) => {
      d.text = "two";
    });
    await repoA.flush();
    await pause(500);

    expect(storeB.mock.calls.length).toBe(storeMark);
    expect(storageB.reads.slice(readMark).filter((k) => k.includes(sid))).toEqual([]);
  });

  it("each bridge unrefs its channel so it does not keep a Node process alive", async () => {
    const unref = vi.spyOn(
      BroadcastChannel.prototype as unknown as { unref(): void },
      "unref"
    );
    await siblings(`test-bus-${Math.random().toString(36).slice(2)}`);
    expect(unref).toHaveBeenCalledTimes(2);
    unref.mockRestore();
  });
});
