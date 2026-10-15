// A Repo's end of the sync node (sync-node.ts): a SubductionRemote over a
// MessagePort. The port can die under it — the SharedWorker restarts after a
// deploy, or the browser terminates it — so it is opened through `open`, and
// `reconnect()` swaps in a fresh one.
import { PeerId } from "@automerge/automerge-subduction/slim";
import type {
  SubductionRemote,
  SubductionRemoteHandlers,
  SubductionRemoteSyncResult,
} from "@automerge/automerge-repo/slim";

import type {
  NodeMessage,
  RecordKind,
  RemoteRequest,
} from "./sync-protocol.js";

/** What ARK's keyhive sync calls on what it takes to be the Repo's Subduction. */
type KeyhiveFrameHandler = {
  onMessage(payload: Uint8Array, peer: PeerId): void;
  onPeerDisconnect(peer: PeerId): void;
};

export type KeyhiveRelay = {
  getConnectedPeerIds(): Promise<PeerId[]>;
  registerFrameHandler(handler?: KeyhiveFrameHandler | null): Promise<void>;
  sendKeyhiveMessage(payload: Uint8Array, peer: PeerId): Promise<void>;
};

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  /** What a request settles to when its port dies under it. */
  orphaned: () => void;
};

export class PortSyncRemote implements SubductionRemote {
  readonly #open: () => MessagePort;
  #port: MessagePort | null = null;
  #handlers: SubductionRemoteHandlers | null = null;
  #onChange: (() => void) | null = null;
  #shutdown = false;
  // Until the node says otherwise it is presumed to be connecting, so a
  // Repo's first queries wait for it rather than reporting unavailable.
  #nodeConnecting = true;
  #nodeConnected = false;
  #generation = 0;
  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #ephemeral = new Set<string>();
  #keyhiveHandler: KeyhiveFrameHandler | null = null;
  /**
   * Writes the node hasn't heard about because there was no port to tell it
   * on. A replacement node hydrates from the database, but only the first
   * time it touches a sedimentree, so these still have to be sent.
   */
  #unsent: Array<Extract<RemoteRequest, { type: "stored" }>> = [];

  constructor(open: () => MessagePort) {
    this.#open = open;
    this.reconnect();
  }

  /** Drop the current port, if any, and open a new one. */
  reconnect(): void {
    if (this.#shutdown) return;
    this.#closePort();
    const port = this.#open();
    this.#port = port;
    port.addEventListener("message", (event) =>
      this.#receive(port, event.data as NodeMessage)
    );
    port.addEventListener("close", () => {
      if (this.#port === port) this.reconnect();
    });
    port.start();
    for (const sid of this.#ephemeral) {
      this.#post({ type: "ephemeral-subscribe", sid });
    }
    if (this.#keyhiveHandler) this.#post({ type: "keyhive-listen" });
    const unsent = this.#unsent;
    this.#unsent = [];
    for (const message of unsent) this.#post(message);
  }

  #closePort() {
    const port = this.#port;
    if (!port) return;
    this.#port = null;
    port.close();
    for (const pending of this.#pending.values()) pending.orphaned();
    this.#pending.clear();
    this.#setState(true, false);
  }

  #post(message: RemoteRequest): boolean {
    if (!this.#port) return false;
    try {
      this.#port.postMessage(message);
      return true;
    } catch (error) {
      console.warn("sync remote: couldn't reach the sync node", error);
      return false;
    }
  }

  #request<T>(
    message: WithoutId<Extract<RemoteRequest, { id: number }>>,
    orphaned: T
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending = { resolve, reject, orphaned: () => resolve(orphaned) };
      this.#pending.set(id, pending);
      if (!this.#post({ ...message, id } as RemoteRequest)) {
        this.#pending.delete(id);
        pending.orphaned();
      }
    });
  }

  #receive(port: MessagePort, message: NodeMessage) {
    if (port !== this.#port) return;
    switch (message.type) {
      case "reply": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if ("error" in message) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
        return;
      }
      case "state":
        this.#setState(message.connecting, message.connected);
        return;
      case "data":
        this.#handlers?.onData(message.sid, message.records);
        return;
      case "heads":
        this.#handlers?.onRemoteHeads(
          message.sid,
          message.peerId,
          message.heads
        );
        return;
      case "ephemeral":
        this.#handlers?.onEphemeral(
          message.sid,
          message.senderId,
          message.payload
        );
        return;
      case "keyhive-frame":
        this.#keyhiveHandler?.onMessage(
          message.payload,
          new PeerId(message.peer)
        );
        return;
      case "keyhive-peer-disconnected":
        this.#keyhiveHandler?.onPeerDisconnect(new PeerId(message.peer));
        return;
    }
  }

  #setState(connecting: boolean, connected: boolean) {
    if (
      connecting === this.#nodeConnecting &&
      connected === this.#nodeConnected
    ) {
      return;
    }
    this.#nodeConnecting = connecting;
    this.#nodeConnected = connected;
    this.#generation++;
    this.#onChange?.();
  }

  // ── ConnectionManager ────────────────────────────────────────────────

  isConnecting(): boolean {
    return !this.#shutdown && (this.#port === null || this.#nodeConnecting);
  }

  isConnected(): boolean {
    return this.#port !== null && this.#nodeConnected;
  }

  generation(): number {
    return this.#generation;
  }

  onChange(callback: () => void): void {
    this.#onChange = callback;
  }

  shutdown(): void {
    this.#shutdown = true;
    this.#closePort();
  }

  // ── SubductionRemote ─────────────────────────────────────────────────

  bind(handlers: SubductionRemoteHandlers): void {
    this.#handlers = handlers;
  }

  // A round cut off by a lost port reports no peers: the source re-syncs as
  // soon as the replacement's state bumps the generation, where a failure
  // would leave it to the healer's backoff.
  sync(
    sid: string,
    timeoutMs: number | null
  ): Promise<SubductionRemoteSyncResult[]> {
    return this.#request({ type: "sync", sid, timeoutMs }, []);
  }

  connectedPeerIds(): Promise<string[]> {
    return this.#request({ type: "peers" }, []);
  }

  stored(sid: string, records: Array<{ kind: RecordKind; id: string }>) {
    const message = { type: "stored" as const, sid, records };
    if (!this.#post(message)) this.#unsent.push(message);
  }

  release(sid: string): void {
    this.#post({ type: "release", sid });
  }

  async subscribeEphemeral(sid: string): Promise<void> {
    this.#ephemeral.add(sid);
    this.#post({ type: "ephemeral-subscribe", sid });
  }

  async unsubscribeEphemeral(sid: string): Promise<void> {
    this.#ephemeral.delete(sid);
    this.#post({ type: "ephemeral-unsubscribe", sid });
  }

  async publishEphemeral(sid: string, payload: Uint8Array): Promise<void> {
    this.#post({ type: "ephemeral-publish", sid, payload });
  }

  // ── Keyhive ──────────────────────────────────────────────────────────

  /**
   * Stands in for the Repo's Subduction as ARK's keyhive sync sees it: the
   * frames it sends go out over the node's connection, and the frames the
   * node receives come back here.
   */
  keyhiveRelay(): KeyhiveRelay {
    return {
      getConnectedPeerIds: async () =>
        (await this.#request<Uint8Array[]>({ type: "keyhive-peers" }, [])).map(
          (bytes) => new PeerId(bytes)
        ),
      registerFrameHandler: async (handler) => {
        this.#keyhiveHandler = handler ?? null;
        this.#post({ type: handler ? "keyhive-listen" : "keyhive-unlisten" });
      },
      sendKeyhiveMessage: async (payload, peer) => {
        this.#post({ type: "keyhive-send", peer: peer.toBytes(), payload });
      },
    };
  }
}

/**
 * automerge-repo-keyhive runs keyhive sync over `repo.subduction`, the Repo's
 * own Subduction node, which has no connection when the Repo syncs through
 * the node. Hand it the remote's relay there instead. ARK is the only reader
 * of `repo.subduction`.
 */
export function relayKeyhive<R extends object>(
  repo: R,
  remote: PortSyncRemote
): R {
  Object.defineProperty(repo, "subduction", {
    value: Promise.resolve(remote.keyhiveRelay()),
  });
  return repo;
}
