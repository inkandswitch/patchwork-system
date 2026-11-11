// A sedimentree backend whose documents are encrypted with keyhive: what it
// stores and what its peers see is ciphertext, and what it hands the Repo
// above it is plaintext. Record ids and parents stay as they are (subduction
// and the server need them), only the blobs change.

import {
  idBytes,
  recordHead,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeRecord,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";
import type { Codec } from "./codec.js";

export type KeyhiveBackendOptions = {
  inner: SedimentreeBackend;
  codec: Codec;
  /**
   * Mint a keyhive document for a new Automerge document whose first records
   * are `records`, and resolve to its id once the sync server knows it (the
   * server refuses blobs for documents it doesn't).
   */
  mint(records: RecordBatch): Promise<SedimentreeId>;
  /**
   * Subscribe to keyhive learning something: blobs that couldn't be opened
   * before are tried again.
   */
  onKeyhiveChange(listener: () => void): () => void;
};

export class KeyhiveBackend implements SedimentreeBackend {
  readonly #inner: SedimentreeBackend;
  readonly #codec: Codec;
  readonly #mint: KeyhiveBackendOptions["mint"];
  readonly #onKeyhiveChange: KeyhiveBackendOptions["onKeyhiveChange"];

  constructor(options: KeyhiveBackendOptions) {
    this.#inner = options.inner;
    this.#codec = options.codec;
    this.#mint = options.mint;
    this.#onKeyhiveChange = options.onKeyhiveChange;
  }

  async create(
    initialRecords: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId> {
    const documentId =
      options?.documentId ?? (await this.#mint(initialRecords));
    const encrypted = await this.#encrypt(documentId, initialRecords);
    return this.#inner.create(encrypted, { documentId });
  }

  async store(id: SedimentreeId, batch: RecordBatch): Promise<void> {
    await this.#inner.store(id, await this.#encrypt(id, batch));
  }

  open(id: SedimentreeId): SedimentreeSession {
    const doc = idBytes(id);
    if (doc.length === 32 && doc.subarray(16, 32).every((byte) => byte === 0)) {
      return this.#inner.open(id);
    }
    return new KeyhiveSession(
      id,
      this.#inner.open(id),
      this.#codec,
      this.#onKeyhiveChange
    );
  }

  flush(ids?: readonly SedimentreeId[]): Promise<void> {
    return this.#inner.flush(ids);
  }

  deleteLocal(id: SedimentreeId): Promise<void> {
    return this.#inner.deleteLocal(id);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  async #encrypt(id: SedimentreeId, batch: RecordBatch): Promise<RecordBatch> {
    const doc = idBytes(id);
    if (doc.length === 32 && doc.subarray(16, 32).every((byte) => byte === 0)) {
      return batch;
    }
    return Promise.all(
      batch.map(async (record): Promise<SedimentreeRecord> => {
        const parents =
          record.kind === "commit" ? record.parents : record.boundary;
        const blob = await this.#codec.encode(
          doc,
          recordHead(record),
          parents,
          record.blob
        );
        return { ...record, blob };
      })
    );
  }
}

/**
 * The inner session's events with every records batch decrypted. Blobs that
 * don't open yet (this device has no access, or not to their keys yet) are
 * held, and tried again whenever keyhive learns something; each one that
 * opens later arrives as a live record. Every ciphertext seen is kept, since
 * opening a blob can need the ancestors it names.
 */
class KeyhiveSession implements SedimentreeSession {
  readonly events: AsyncIterable<SedimentreeEvent>;
  readonly #inner: SedimentreeSession;

  constructor(
    id: SedimentreeId,
    inner: SedimentreeSession,
    codec: Codec,
    onKeyhiveChange: (listener: () => void) => () => void
  ) {
    this.#inner = inner;
    const doc = idBytes(id);
    // every ciphertext record seen, and which of them haven't opened yet
    const seen: SedimentreeRecord[] = [];
    const held = new Set<SedimentreeRecord>();

    // decrypts the records it can of `records`, retrying `held` alongside
    const open = async (records: readonly SedimentreeRecord[]) => {
      seen.push(...records);
      const plain = await codec.decode(
        doc,
        seen.map((r) => [recordHead(r), r.blob] as const)
      );
      const out: SedimentreeRecord[] = [];
      for (const record of [...held, ...records]) {
        const blob = plain.get(record.blob);
        if (blob) {
          held.delete(record);
          out.push({ ...record, blob });
        } else {
          held.add(record);
        }
      }
      return out;
    };

    let sequence = 0;
    const queue = new EventQueue();
    // a retry runs between inner events, never alongside one
    let busy: Promise<void> = Promise.resolve();
    const serially = (f: () => Promise<void>) =>
      (busy = busy.then(f, f).catch((e) => queue.fail(e)));

    const unsubscribe = onKeyhiveChange(() => {
      if (!held.size) return;
      void serially(async () => {
        const records = await open([]);
        if (records.length) {
          queue.push({ type: "records", sequence, phase: "live", records });
        }
      });
    });

    void (async () => {
      try {
        for await (const event of inner.events) {
          sequence = "sequence" in event ? event.sequence : sequence;
          await serially(async () => {
            if (event.type !== "records") {
              queue.push(event);
              return;
            }
            const records = await open(event.records);
            // an initial batch is passed on even when empty, so the load's
            // shape is unchanged; a live one with nothing new is dropped
            if (records.length || event.phase === "initial") {
              queue.push({ ...event, records });
            }
          });
        }
        await busy;
        queue.end();
      } catch (e) {
        queue.fail(e);
      } finally {
        unsubscribe();
      }
    })();

    this.events = queue;
  }

  publishEphemeral(
    message: Parameters<SedimentreeSession["publishEphemeral"]>[0]
  ): Promise<void> {
    return this.#inner.publishEphemeral(message);
  }

  markReady(): void {
    this.#inner.markReady();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

/** An async iterable fed from outside, ending or failing once. */
export class EventQueue<T = SedimentreeEvent> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiting: {
    resolve(r: IteratorResult<T>): void;
    reject(e: unknown): void;
  }[] = [];
  #done = false;
  #error: { error: unknown } | undefined;

  push(item: T): void {
    if (this.#done) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiting.splice(0)) {
      w.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#done) return;
    this.#error = { error };
    this.#done = true;
    for (const w of this.#waiting.splice(0)) w.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length) {
          return Promise.resolve({ value: this.#items.shift()!, done: false });
        }
        if (this.#error) return Promise.reject(this.#error.error);
        if (this.#done)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          this.#waiting.push({ resolve, reject })
        );
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
