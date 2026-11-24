import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicReaderStatus } from "../src/public-pair.js";

// Keyhive is wasm the relay doesn't need: a reader whose ingest each test
// drives by hand, and a fetcher whose events it emits itself.
const fake = vi.hoisted(() => ({
  ingest: undefined as unknown as ReturnType<typeof vi.fn>,
  fetcher: undefined as unknown as { emitter: EventEmitter },
}));

vi.mock("@automerge/automerge-repo-keyhive", () => {
  let totalOps = 0;
  const reader = {
    stats: async () => ({ totalOps }),
    ingestEventsBytes: async (events: Uint8Array[]) => {
      await fake.ingest(events);
      totalOps += events.length;
    },
    ingestArchive: async () => {},
    toArchive: async () => ({ toBytes: () => new Uint8Array() }),
  };
  return {
    ContactCard: {
      fromBytes: () => ({ id: { toBytes: () => new Uint8Array(32) } }),
    },
    Signer: {
      webCryptoSigner: async () => ({}),
      memorySignerFromBytes: () => ({ verifyingKey: new Uint8Array(32) }),
    },
    CiphertextStore: { newInMemory: () => ({}) },
    Archive: class {
      tryToKeyhive = async () => reader;
    },
    initializeAutomergeRepoKeyhive: async () => ({
      hive: {
        ...fake.fetcher,
        keyhive: { toArchive: async () => ({}) },
        accessForDoc: async () => undefined,
      },
      repo: { peerId: "reader", shareConfigChanged: () => {} },
    }),
  };
});

let statuses: PublicReaderStatus[];
const event = (n: number) => ({ toBytes: () => new Uint8Array([n]) });
const ingested = () =>
  fake.ingest.mock.calls.map(([events]) =>
    (events as Uint8Array[]).map((bytes) => bytes[0])
  );

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey);
  vi.spyOn(crypto.subtle, "generateKey").mockResolvedValue({
    publicKey: {},
    privateKey: {},
  } as CryptoKeyPair);
  fake.ingest = vi.fn(async () => {});
  fake.fetcher = { emitter: new EventEmitter() };
  statuses = [];
  const { startPublicReader } = await import("../src/public-pair.js");
  await startPublicReader({
    url: "ws://sync.test",
    syncServer: {} as never,
    onStatus: (status) => statuses.push(status),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emit = (n: number) => fake.fetcher.emitter.emit("update", event(n));
const phase = () => statuses.at(-1)?.phase;

// A batch is tried at 100ms, then again after 200, 400, 800 and 1600ms.
const FIRST_FOUR_TRIES_MS = 100 + 200 + 400 + 800;
const LAST_TRY_AFTER_MS = 1600;

describe("relaying keyhive events to the reader", () => {
  it("gives up on a batch after five tries, and tries again when more arrive", async () => {
    fake.ingest.mockRejectedValue(new Error("busy"));
    emit(1);
    await vi.advanceTimersByTimeAsync(FIRST_FOUR_TRIES_MS + LAST_TRY_AFTER_MS);
    expect(ingested()).toEqual([[1], [1], [1], [1], [1]]);
    expect(phase()).toBe("failed");

    // nothing more arrives, so nothing more is tried
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.ingest).toHaveBeenCalledTimes(5);

    fake.ingest.mockResolvedValue(undefined);
    emit(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(ingested().at(-1)).toEqual([1, 2]);
    expect(phase()).toBe("ready");
  });

  it("tries events that arrive during the last failing try", async () => {
    fake.ingest.mockRejectedValue(new Error("busy"));
    emit(1);
    await vi.advanceTimersByTimeAsync(FIRST_FOUR_TRIES_MS);
    expect(fake.ingest).toHaveBeenCalledTimes(4);

    // the fifth try is still going when the next event arrives, and that
    // event's own wait runs out before the try fails
    let fail!: (error: Error) => void;
    fake.ingest.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject))
    );
    await vi.advanceTimersByTimeAsync(LAST_TRY_AFTER_MS);
    expect(fake.ingest).toHaveBeenCalledTimes(5);
    emit(2);
    await vi.advanceTimersByTimeAsync(100);
    fake.ingest.mockResolvedValue(undefined);
    fail(new Error("busy"));
    await vi.advanceTimersByTimeAsync(100);

    expect(ingested().at(-1)).toEqual([1, 2]);
    expect(phase()).toBe("ready");
  });
});
