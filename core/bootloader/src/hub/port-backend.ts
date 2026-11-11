// A tab's sedimentree backend: everything goes to the automerge worker over a
// MessagePort. The worker can be replaced (a newer build, a crash); `attach`
// is called with a port to each new one, and the tab carries on: its open
// sessions open again there and calls it hadn't had an answer to are sent
// again. Until a first port is attached, calls wait.

import {
  BackendError,
  type EphemeralEnvelope,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";
import { EventQueue } from "../keyline/backend.js";
import type {
  BackendCall,
  ClientMessage,
  HubInfo,
  HubMessage,
  SerializedError,
} from "./protocol.js";

/** How long closing waits for the worker to take what's pending. */
const CLOSE_FLUSH_MS = 2_000;

type Pending = {
  body: BackendCall;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

type Session = {
  documentId: SedimentreeId;
  queue: EventQueue;
  /** Opened on some worker already, so another one's initial load is old news. */
  opened: boolean;
  ready: boolean;
};

export class PortBackend implements SedimentreeBackend {
  #port: MessagePort | undefined;
  #nextCall = 0;
  #nextSession = 0;
  readonly #calls = new Map<number, Pending>();
  readonly #sessions = new Map<number, Session>();
  readonly #hiveListeners = new Set<() => void>();
  /** Sessions opened again on a new worker, until its initial load is done. */
  readonly #reopened = new WeakSet<Session>();
  readonly #lock: string;
  #closed = false;
  #serverConnected = false;
  readonly #statusListeners = new Set<(connected: boolean) => void>();

  /** Whether the worker is connected to the sync server, as it last said. */
  get serverConnected(): boolean {
    return this.#serverConnected;
  }

  /** Hear whenever the worker's connection to the sync server comes or goes. */
  onServerStatus(listener: (connected: boolean) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** `lock` is a Web Lock this tab holds while it lives; see protocol.ts. */
  constructor(lock: string) {
    this.#lock = lock;
  }

  /** Talk to the worker on the other end of `port` from now on. */
  attach(port: MessagePort): void {
    if (this.#closed) return port.close();
    this.#port?.close();
    this.#port = port;
    port.onmessage = (event) => this.#receive(event.data as HubMessage);
    port.start();
    this.#send({ type: "hello", lock: this.#lock });
    for (const [session, s] of this.#sessions) {
      if (s.opened) this.#reopened.add(s);
      s.opened = true;
      this.#send({ type: "open", session, documentId: s.documentId });
      if (s.ready) this.#send({ type: "markReady", session });
    }
    for (const [call, { body }] of this.#calls) {
      this.#send({ type: "call", call, body });
    }
  }

  /** Hear when keyhive in the worker learns something. */
  onHiveChange(listener: () => void): () => void {
    this.#hiveListeners.add(listener);
    return () => this.#hiveListeners.delete(listener);
  }

  /** Ask the worker something that isn't a backend operation. */
  call<T>(body: BackendCall): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new BackendError("close", "closed", "the backend is closed")
      );
    }
    const call = this.#nextCall++;
    return new Promise<T>((resolve, reject) => {
      this.#calls.set(call, {
        body,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.#send({ type: "call", call, body });
    });
  }

  /** The peers the worker is connected to (the sync server), hex. */
  serverPeers(): Promise<string[]> {
    return this.call<string[]>({ op: "serverPeers" });
  }

  /** Cut or restore the worker's link to the sync server (bench, dev). */
  setOffline(offline: boolean): Promise<void> {
    return this.call({ op: "setOffline", offline });
  }

  /** Who the worker is. */
  info(): Promise<HubInfo> {
    return this.call<HubInfo>({ op: "info" });
  }

  create(
    records: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId> {
    return this.call({ op: "create", records, ...options });
  }

  store(documentId: SedimentreeId, records: RecordBatch): Promise<void> {
    return this.call({ op: "store", documentId, records });
  }

  flush(ids?: readonly SedimentreeId[]): Promise<void> {
    return this.call({ op: "flush", ids: ids && [...ids] });
  }

  deleteLocal(documentId: SedimentreeId): Promise<void> {
    return this.call({ op: "deleteLocal", documentId });
  }

  open(documentId: SedimentreeId): SedimentreeSession {
    const session = this.#nextSession++;
    const state: Session = {
      documentId,
      queue: new EventQueue(),
      opened: false,
      ready: false,
    };
    this.#sessions.set(session, state);
    if (this.#port) {
      this.#send({ type: "open", session, documentId });
      state.opened = true;
    }
    return {
      events: state.queue,
      publishEphemeral: (message: EphemeralEnvelope) =>
        this.call({ op: "publishEphemeral", session, message }),
      markReady: () => {
        state.ready = true;
        this.#send({ type: "markReady", session });
      },
      close: async () => {
        if (!this.#sessions.delete(session)) return;
        this.#send({ type: "close", session });
        state.queue.end();
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // pending writes are the worker's to finish, since it outlives us; this
    // only waits for them to reach it, and not forever on one that's gone
    await Promise.race([
      this.flush().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_MS)),
    ]);
    this.#closed = true;
    for (const [session, s] of this.#sessions) {
      this.#send({ type: "close", session });
      s.queue.end();
    }
    this.#sessions.clear();
    const closed = new BackendError("close", "closed", "the backend closed");
    for (const { reject } of this.#calls.values()) reject(closed);
    this.#calls.clear();
    this.#port?.close();
    this.#port = undefined;
  }

  #send(message: ClientMessage): void {
    this.#port?.postMessage(message);
  }

  #receive(message: HubMessage): void {
    switch (message.type) {
      case "reply": {
        const pending = this.#calls.get(message.call);
        if (!pending) return;
        this.#calls.delete(message.call);
        if (message.error) pending.reject(deserializeError(message.error));
        else pending.resolve(message.value);
        return;
      }
      case "event": {
        const s = this.#sessions.get(message.session);
        if (!s) return;
        const event = this.#resumeEvent(s, message.event);
        if (event) s.queue.push(event);
        return;
      }
      case "end": {
        const s = this.#sessions.get(message.session);
        if (!s) return;
        this.#sessions.delete(message.session);
        if (message.error) s.queue.fail(deserializeError(message.error));
        else s.queue.end();
        return;
      }
      case "hive-change":
        for (const listener of this.#hiveListeners) listener();
        return;
      case "status":
        if (this.#serverConnected === message.connected) return;
        this.#serverConnected = message.connected;
        for (const listener of this.#statusListeners)
          listener(message.connected);
        return;
    }
  }

  // A session that resumed on a new worker gets that worker's initial load,
  // which the Repo has seen: its records go in as live ones (Automerge skips
  // what it has), and the second end-of-load is dropped.
  #resumeEvent(s: Session, event: SedimentreeEvent): SedimentreeEvent | null {
    if (!this.#reopened.has(s)) return event;
    if (event.type === "local-load-complete") {
      this.#reopened.delete(s);
      return null;
    }
    if (event.type === "records" && event.phase === "initial") {
      return { ...event, phase: "live" };
    }
    return event;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof BackendError) {
    return {
      message: error.message,
      name: error.name,
      operation: error.operation,
      code: error.code,
      retryable: error.retryable,
    };
  }
  const e = error as { message?: unknown; name?: unknown };
  return {
    message: typeof e?.message === "string" ? e.message : String(error),
    name: typeof e?.name === "string" ? e.name : undefined,
  };
}

export function deserializeError(error: SerializedError): Error {
  if (error.operation && error.code) {
    return new BackendError(
      error.operation,
      error.code as BackendError["code"],
      error.message,
      error.retryable
    );
  }
  const e = new Error(error.message);
  if (error.name) e.name = error.name;
  return e;
}
