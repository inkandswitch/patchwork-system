// The origin's one networked Subduction node. It lives in the automerge
// protocol handler SharedWorker and holds the only connections to the sync
// server; every Repo on the origin (each tab's, and the worker's own resolver)
// syncs through it as a SubductionRemote over a MessagePort.
//
// The Repos and the node share one IndexedDB, in the layout automerge-repo's
// SubductionStorageBridge writes, so neither side ships document data to the
// other just to persist it:
//
// - A Repo saves its own commits straight to the database and then tells the
//   node which records it stored. The node's in-memory sedimentree can't see
//   writes made after it was hydrated, so it reads those records back and
//   stores them into its own tree; the sync round the Repo asks for next is
//   what pushes them.
// - What peers send, the node persists through the same bridge and forwards
//   to the Repos holding that document, which apply it the way they'd apply a
//   commit from their own connection.
// - A Repo can also watch a document it doesn't hold. The node keeps it
//   subscribed with the server and says `changed` when anything arrives for
//   it, without sending the data, so the Repo can leave it unloaded until it
//   wants the new heads.
//
// On keyhive sites the documents are encrypted and the node never decrypts
// them: it stores and forwards the ciphertext the Repos wrote and the server
// sent. Each Repo's keyhive keeps syncing with the server itself, over the
// node's connection: the node relays keyhive frames both ways. The server
// sees one peer either way (every context signs as the keyhive identity), so
// a frame it sends goes to every listening Repo, as it would have reached
// whichever of their sockets the server picked.
import {
  CommitId,
  CommitInput,
  FragmentInput,
  PeerId,
  SedimentreeId,
  Subduction,
  Topic,
} from "@automerge/automerge-subduction/slim";
import {
  SubductionConnections,
  SubductionStorageBridge,
  WebSocketEndpoint,
  type StorageAdapterInterface,
  type StorageKey,
  type WebSocketEndpointInterface,
} from "@automerge/automerge-repo/slim";

import type {
  NodeMessage,
  RecordKind,
  RemoteRequest,
  SyncResult,
} from "./sync-protocol.js";

type DataRecord = { kind: RecordKind; id: string; blob: Uint8Array };

type Client = {
  port: MessagePort;
  /** Sedimentrees this Repo holds, which it wants to hear about. */
  interests: Set<string>;
  /** Sedimentrees this Repo wants `changed` for, held or not. */
  watching: Set<string>;
  ephemeral: Set<string>;
  keyhive: boolean;
  /** Per sedimentree, the tick of this Repo's last write the node heard of. */
  wrote: Map<string, number>;
};

type Round = { result: Promise<SyncResult[]>; startedAt: number };

export type SyncNodeOptions = {
  /** Must be the same identity the Repos sign with. */
  signer: unknown;
  /** The database the Repos use. */
  storage: StorageAdapterInterface;
  /** The bridge's key prefix; the interceptor prefix on keyhive sites. */
  storagePrefix?: string;
  endpoints: Array<string | WebSocketEndpointInterface>;
  log: (...args: unknown[]) => void;
};

const sedimentreeId = (sid: string): SedimentreeId =>
  SedimentreeId.fromBytes(
    Uint8Array.from(sid.match(/../g) ?? [], (byte) => parseInt(byte, 16))
  );

// A watched document's round has no Repo waiting on it to pick a deadline.
const WATCH_SYNC_TIMEOUT_MS = 60_000;

const topic = (sid: string) => Topic.fromBytes(sedimentreeId(sid).toBytes());

export class SyncNode {
  readonly subduction: Subduction;
  readonly #bridge: SubductionStorageBridge;
  readonly #connections: SubductionConnections;
  readonly #log: (...args: unknown[]) => void;
  readonly #storagePrefix: string | undefined;
  readonly #clients = new Set<Client>();
  /** Per sedimentree, the tail of the chain of reads-back of Repo writes. */
  readonly #ingesting = new Map<string, Promise<void>>();
  /**
   * `${sid}:${id}` of records being stored back from a Repo's write. The
   * bridge announces them like anything a peer sent; they're forwarded from
   * the read-back instead, so the Repo that wrote them can be left out.
   */
  readonly #echoes = new Set<string>();
  /** Per sedimentree, how many reads-back are storing records into it. */
  readonly #echoing = new Map<string, number>();
  /** Peer deliveries waiting for this microtask's flush, per sedimentree. */
  readonly #outbound = new Map<string, DataRecord[]>();
  readonly #ephemeralSubscribers = new Map<string, number>();
  /** Per sedimentree, the round with the server in progress. */
  readonly #rounds = new Map<string, Round>();
  /** Orders Repo writes against round starts. */
  #tick = 0;
  /** Per sedimentree, the round queued behind it, shared by every asker. */
  readonly #queued = new Map<string, Promise<SyncResult[]>>();
  /**
   * Sedimentrees the server has said it will push to us, since we last
   * connected. A round subscribes; a dropped connection forgets them all.
   */
  readonly #subscribed = new Set<string>();
  #connected = false;

  constructor({
    signer,
    storage,
    storagePrefix,
    endpoints,
    log,
  }: SyncNodeOptions) {
    this.#log = log;
    this.#storagePrefix = storagePrefix;
    this.#bridge = new SubductionStorageBridge(
      this.#skippingEchoes(storage),
      storagePrefix
    );
    this.subduction = new Subduction({
      signer: signer as any,
      storage: this.#bridge,
      onRemoteHeads: (
        id: SedimentreeId,
        peer: { toString(): string },
        heads: Array<{ toHexString(): string }>
      ) => {
        const sid = id.toString();
        this.#sendToInterested(sid, {
          type: "heads",
          sid,
          peerId: peer.toString(),
          heads: heads.map((head) => head.toHexString()),
        });
      },
      onEphemeral: (
        id: SedimentreeId,
        sender: { toString(): string },
        payload: Uint8Array
      ) => {
        const sid = id.toString();
        const message: NodeMessage = {
          type: "ephemeral",
          sid,
          senderId: sender.toString(),
          payload,
        };
        for (const client of this.#clients) {
          if (client.ephemeral.has(sid)) this.#send(client, message);
        }
      },
    });

    void this.subduction.registerFrameHandler({
      onMessage: (payload: Uint8Array, peer: PeerId) =>
        this.#sendToKeyhive({
          type: "keyhive-frame",
          peer: peer.toBytes(),
          payload,
        }),
      onPeerDisconnect: (peer: PeerId) =>
        this.#sendToKeyhive({
          type: "keyhive-peer-disconnected",
          peer: peer.toBytes(),
        }),
    });

    this.#bridge.on("commit-saved", (id, commitId, blob) =>
      this.#saved(id.toString(), "commit", commitId.toHexString(), blob)
    );
    this.#bridge.on("fragment-saved", (id, head, blob) =>
      this.#saved(id.toString(), "fragment", head.toHexString(), blob)
    );

    this.#connections = new SubductionConnections(
      Promise.resolve(this.subduction)
    );
    this.#connections.onChange(() => {
      const state = this.#state();
      this.#log("sync node connection state", state);
      for (const client of this.#clients) this.#send(client, state);
      this.#handleConnectionChange();
    });
    for (const endpoint of endpoints) {
      void this.#connections.manageConnection(
        typeof endpoint === "string"
          ? new WebSocketEndpoint(endpoint)
          : endpoint
      );
    }
  }

  /** Serve a Repo over `port` until it closes. */
  connect(port: MessagePort): void {
    const client: Client = {
      port,
      interests: new Set(),
      watching: new Set(),
      ephemeral: new Set(),
      wrote: new Map(),
      keyhive: false,
    };
    this.#clients.add(client);
    port.addEventListener("message", (event) => {
      void this.#handle(client, event.data as RemoteRequest);
    });
    // Fires when the tab holding the other end goes away.
    port.addEventListener("close", () => this.#disconnect(client));
    port.start();
    this.#send(client, this.#state());
  }

  /** Persist everything stored back so far, and stop reconnecting. */
  async shutdown(): Promise<void> {
    this.#connections.shutdown();
    await Promise.all(this.#ingesting.values());
    await this.#bridge.awaitSettled();
    for (const client of this.#clients) client.port.close();
    this.#clients.clear();
  }

  #state(): NodeMessage {
    return {
      type: "state",
      connecting: this.#connections.isConnecting(),
      connected: this.#connections.isConnected(),
    };
  }

  #disconnect(client: Client) {
    if (!this.#clients.delete(client)) return;
    for (const sid of client.ephemeral) void this.#unsubscribeEphemeral(sid);
  }

  #send(client: Client, message: NodeMessage) {
    try {
      client.port.postMessage(message);
    } catch (error) {
      console.warn("sync node: couldn't reach a Repo, dropping it", error);
      this.#disconnect(client);
    }
  }

  #sendToKeyhive(message: NodeMessage) {
    for (const client of this.#clients) {
      if (client.keyhive) this.#send(client, message);
    }
  }

  /** Tell every Repo watching `sid` that it may have new heads. */
  #sendChanged(sid: string) {
    const message: NodeMessage = { type: "changed", sid };
    for (const client of this.#clients) {
      if (client.watching.has(sid)) this.#send(client, message);
    }
  }

  /**
   * The Repos holding a document resync it themselves when the connection
   * comes back. Nobody holds a watched one, so the node resubscribes it.
   */
  #handleConnectionChange() {
    const connected = this.#connections.isConnected();
    if (connected === this.#connected) return;
    this.#connected = connected;
    if (!connected) {
      this.#subscribed.clear();
      return;
    }
    const watched = new Set<string>();
    for (const client of this.#clients) {
      for (const sid of client.watching) watched.add(sid);
    }
    for (const sid of watched) this.#subscribe(sid);
  }

  /**
   * Run a round for `sid` unless the server is already pushing it to us. A
   * round already running may have started before the connection was up, so
   * look again once it's done, but only once: a round the server turns down
   * would otherwise be asked for again forever.
   */
  #subscribe(sid: string, waitForRunning = true) {
    if (this.#subscribed.has(sid)) return;
    const running = this.#rounds.get(sid);
    if (running) {
      if (waitForRunning) {
        void running.result
          .catch(() => {})
          .then(() => this.#subscribe(sid, false));
      }
      return;
    }
    this.#startRound(sid, WATCH_SYNC_TIMEOUT_MS).catch((error) =>
      this.#log(`couldn't subscribe to ${sid}`, error)
    );
  }

  #sendToInterested(sid: string, message: NodeMessage, except?: Client) {
    for (const client of this.#clients) {
      if (client !== except && client.interests.has(sid)) {
        this.#send(client, message);
      }
    }
  }

  async #handle(client: Client, request: RemoteRequest) {
    switch (request.type) {
      case "sync": {
        client.interests.add(request.sid);
        await this.#reply(client, request.id, () =>
          this.#sync(client, request.sid, request.timeoutMs)
        );
        return;
      }
      case "peers": {
        await this.#reply(client, request.id, async () =>
          (await this.subduction.getConnectedPeerIds()).map(String)
        );
        return;
      }
      case "keyhive-peers": {
        await this.#reply(client, request.id, async () =>
          (await this.subduction.getConnectedPeerIds()).map((peer) =>
            peer.toBytes()
          )
        );
        return;
      }
      case "keyhive-listen":
        client.keyhive = true;
        return;
      case "keyhive-unlisten":
        client.keyhive = false;
        return;
      case "keyhive-send":
        await this.subduction
          .sendKeyhiveMessage(request.payload, new PeerId(request.peer))
          .catch((error) => this.#log("keyhive send failed", error));
        return;
      case "stored":
        client.interests.add(request.sid);
        client.wrote.set(request.sid, ++this.#tick);
        this.#ingest(client, request.sid, request.records);
        return;
      case "release":
        client.interests.delete(request.sid);
        client.wrote.delete(request.sid);
        return;
      case "watch":
        client.watching.add(request.sid);
        this.#subscribe(request.sid);
        return;
      case "unwatch":
        client.watching.delete(request.sid);
        return;
      case "ephemeral-subscribe":
        if (client.ephemeral.has(request.sid)) return;
        client.ephemeral.add(request.sid);
        await this.#subscribeEphemeral(request.sid);
        return;
      case "ephemeral-unsubscribe":
        if (!client.ephemeral.delete(request.sid)) return;
        await this.#unsubscribeEphemeral(request.sid);
        return;
      case "ephemeral-publish": {
        const { sid, payload } = request;
        // The server doesn't echo it back to us, so the other Repos on the
        // origin hear it from here.
        const message: NodeMessage = {
          type: "ephemeral",
          sid,
          senderId: "local",
          payload,
        };
        for (const other of this.#clients) {
          if (other !== client && other.ephemeral.has(sid)) {
            this.#send(other, message);
          }
        }
        await this.subduction
          .publishEphemeral(topic(sid), payload)
          .catch((error) => this.#log("ephemeral publish failed", error));
        return;
      }
    }
  }

  async #reply(client: Client, id: number, run: () => Promise<unknown>) {
    try {
      this.#send(client, { type: "reply", id, value: await run() });
    } catch (error) {
      this.#send(client, { type: "reply", id, error: String(error) });
    }
  }

  /**
   * Every Repo holding a document asks for its own rounds, and tabs opening
   * the same document all ask at once. A Repo that hasn't written since the
   * running round started shares that round. One that has waits for the
   * next, since the running round's tree was read before that write was
   * stored, and every such Repo shares the next one. So a crowd of tabs
   * opening a document costs one round, and a crowd of writers at most two.
   * The queued round runs with the first asker's timeout.
   */
  #sync(
    client: Client,
    sid: string,
    timeoutMs: number | null
  ): Promise<SyncResult[]> {
    const running = this.#rounds.get(sid);
    if (!running) return this.#startRound(sid, timeoutMs);
    if ((client.wrote.get(sid) ?? 0) <= running.startedAt) {
      return running.result;
    }
    const queued = this.#queued.get(sid);
    if (queued) return queued;
    const next = running.result
      .catch(() => {})
      .then(() => {
        this.#queued.delete(sid);
        return this.#startRound(sid, timeoutMs);
      });
    this.#queued.set(sid, next);
    return next;
  }

  #startRound(sid: string, timeoutMs: number | null) {
    const round: Round = {
      result: this.#round(sid, timeoutMs),
      startedAt: this.#tick,
    };
    this.#rounds.set(sid, round);
    void round.result
      .catch(() => {})
      .finally(() => {
        if (this.#rounds.get(sid) === round) this.#rounds.delete(sid);
      });
    return round.result;
  }

  async #round(sid: string, timeoutMs: number | null): Promise<SyncResult[]> {
    // Whatever a Repo stored before asking has to be in the tree the round
    // reads, or the round pushes around it.
    await this.#ingesting.get(sid);
    const results = await this.subduction.syncWithAllPeers(
      sedimentreeId(sid),
      true,
      timeoutMs
    );
    // The Repo reads what arrived out of the database as soon as we reply.
    await this.#bridge.awaitSettled([sid]);
    this.#flush(sid);
    const mapped = results.entries().map((result) => ({
      success: result.success,
      transportErrors: result.transportErrors?.map(String),
      stats: result.stats && {
        commitsReceived: result.stats.commitsReceived,
        fragmentsReceived: result.stats.fragmentsReceived,
      },
    }));
    if (mapped.some((result) => result.success)) this.#subscribed.add(sid);
    return mapped;
  }

  #ingest(
    from: Client,
    sid: string,
    records: Array<{ kind: RecordKind; id: string }>
  ) {
    const previous = this.#ingesting.get(sid) ?? Promise.resolve();
    const next = previous
      .then(() => this.#storeBack(from, sid, records))
      .catch((error) =>
        console.error(`sync node: couldn't pick up writes to ${sid}`, error)
      );
    this.#ingesting.set(sid, next);
    void next.finally(() => {
      if (this.#ingesting.get(sid) === next) this.#ingesting.delete(sid);
    });
  }

  /**
   * Store a Repo's records into this node's tree. They're signed by the
   * identity this node shares with every Repo, so storing them again writes
   * the same bytes to the same keys.
   */
  async #storeBack(
    from: Client,
    sid: string,
    records: Array<{ kind: RecordKind; id: string }>
  ) {
    const id = sedimentreeId(sid);
    const commits: CommitInput[] = [];
    const fragments: FragmentInput[] = [];
    const forward: DataRecord[] = [];
    for (const record of records) {
      const commitId = CommitId.fromHexString(record.id);
      // Gone means compacted away: automerge absorbed it into a fragment,
      // which the Repo reports separately.
      if (record.kind === "commit") {
        const stored = await this.#bridge.loadCommit(id, commitId);
        if (!stored) continue;
        commits.push(new CommitInput(stored.signed.payload, stored.blob));
        forward.push({ ...record, blob: stored.blob });
      } else {
        const stored = await this.#bridge.loadFragment(id, commitId);
        if (!stored) continue;
        fragments.push(new FragmentInput(stored.signed.payload, stored.blob));
        forward.push({ ...record, blob: stored.blob });
      }
    }
    if (forward.length === 0) return;
    // The writer already persisted these, so the other Repos holding this
    // document can have them now rather than after this node's own store,
    // and rather than by reloading the whole document when the writer's
    // heads announcement lands.
    this.#sendToInterested(sid, { type: "data", sid, records: forward }, from);
    // The writer too: what watches a document in a Repo isn't what holds it.
    this.#sendChanged(sid);

    const keys = forward.map((record) => `${sid}:${record.id}`);
    for (const key of keys) this.#echoes.add(key);
    this.#echoing.set(sid, (this.#echoing.get(sid) ?? 0) + 1);
    try {
      await this.subduction.storeBuiltBatch(id, commits, fragments);
      await this.#bridge.awaitSettled([sid]);
    } finally {
      for (const key of keys) this.#echoes.delete(key);
      const left = this.#echoing.get(sid)! - 1;
      if (left) this.#echoing.set(sid, left);
      else this.#echoing.delete(sid);
    }
  }

  /**
   * The bridge's storage, minus the writes of records being stored back.
   * The Repo already wrote them, and this node signs as the same identity
   * with deterministic signatures, so they'd be the same bytes under the
   * same keys: what's left of storing back is getting them into this node's
   * tree, without four sequential writes holding up the round behind it.
   * The sedimentree's id marker is skipped too while it's being stored back
   * into, since the Repo's save wrote it first.
   */
  #skippingEchoes(storage: StorageAdapterInterface): StorageAdapterInterface {
    // The bridge's default prefix. Were it ever to drift, nothing would be
    // skipped, which is only slower.
    const prefix = this.#storagePrefix ?? "subduction";
    const echoed = (key: StorageKey) => {
      if (key[0] !== prefix) return false;
      if (key.length === 4) return this.#echoes.has(`${key[2]}:${key[3]}`);
      return key.length === 3 && key[1] === "ids" && this.#echoing.has(key[2]);
    };
    return {
      load: (key) => storage.load(key),
      loadRange: (prefix) => storage.loadRange(prefix),
      remove: (key) => storage.remove(key),
      removeRange: (prefix) => storage.removeRange(prefix),
      save: async (key, data) => {
        if (!echoed(key)) await storage.save(key, data);
      },
      saveBatch: async (entries) => {
        const kept = entries.filter(([key]) => !echoed(key));
        if (kept.length === 0) return;
        if (storage.saveBatch) await storage.saveBatch(kept);
        else for (const [key, data] of kept) await storage.save(key, data);
      },
    };
  }

  #saved(sid: string, kind: RecordKind, id: string, blob: Uint8Array) {
    if (this.#echoes.has(`${sid}:${id}`)) return;
    let queued = this.#outbound.get(sid);
    if (!queued) {
      queued = [];
      this.#outbound.set(sid, queued);
      queueMicrotask(() => this.#flush(sid));
    }
    queued.push({ kind, id, blob });
  }

  #flush(sid: string) {
    const records = this.#outbound.get(sid);
    if (!records) return;
    this.#outbound.delete(sid);
    this.#sendToInterested(sid, { type: "data", sid, records });
    this.#sendChanged(sid);
  }

  async #subscribeEphemeral(sid: string) {
    const count = this.#ephemeralSubscribers.get(sid) ?? 0;
    this.#ephemeralSubscribers.set(sid, count + 1);
    if (count > 0) return;
    await this.subduction
      .subscribeEphemeral([topic(sid)])
      .catch((error) => this.#log("ephemeral subscribe failed", error));
  }

  async #unsubscribeEphemeral(sid: string) {
    const count = this.#ephemeralSubscribers.get(sid) ?? 0;
    if (count > 1) {
      this.#ephemeralSubscribers.set(sid, count - 1);
      return;
    }
    this.#ephemeralSubscribers.delete(sid);
    if (count === 0) return;
    await this.subduction
      .unsubscribeEphemeral([topic(sid)])
      .catch((error) => this.#log("ephemeral unsubscribe failed", error));
  }
}
