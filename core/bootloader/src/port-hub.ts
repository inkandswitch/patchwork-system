import {
  NetworkAdapter,
  type Message,
  type NetworkAdapterInterface,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo/slim";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";

/**
 * Subduction service name for the tab ↔ automerge worker link. Both ends have
 * to name the same service or the handshake never completes.
 */
export const WORKER_SUBDUCTION_SERVICE = "patchwork-automerge-worker";

/**
 * One network adapter over many MessagePorts, so ports can come and go after
 * the Repo is built. `subductionAdapters` is read once at construction: the
 * worker gains a tab's port long after that, and a tab gets a fresh port every
 * time the worker is recreated.
 *
 * Each port keeps its own MessageChannelNetworkAdapter, which owns the
 * arrive/welcome handshake; the hub fans their messages in and routes outgoing
 * ones by targetId. Subduction's AdapterConnections opens a transport per
 * peer-candidate, so one hub carries a transport per port.
 */
export class PortHubAdapter extends NetworkAdapter {
  #children = new Set<MessageChannelNetworkAdapter>();
  #byPeer = new Map<PeerId, MessageChannelNetworkAdapter>();
  #waiting: MessageChannelNetworkAdapter[] = [];
  #peered = Promise.withResolvers<void>();
  #useWeakRef: boolean;

  constructor({ useWeakRef = false }: { useWeakRef?: boolean } = {}) {
    super();
    this.#useWeakRef = useWeakRef;
  }

  isReady(): boolean {
    return this.#byPeer.size > 0;
  }

  /** Resolves once some port has announced a peer. */
  whenReady(): Promise<void> {
    return this.#peered.promise;
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    for (const child of this.#waiting.splice(0)) {
      child.connect(peerId, peerMetadata);
    }
  }

  /** Returns a function that drops this port again. */
  addPort(port: MessagePort): () => void {
    const child = new MessageChannelNetworkAdapter(port, {
      useWeakRef: this.#useWeakRef,
    });
    this.#children.add(child);

    child.on("peer-candidate", (payload) => {
      this.#byPeer.set(payload.peerId, child);
      this.#peered.resolve();
      this.emit("peer-candidate", payload);
    });
    child.on("peer-disconnected", (payload) => {
      if (this.#byPeer.get(payload.peerId) === child) {
        this.#byPeer.delete(payload.peerId);
      }
      this.emit("peer-disconnected", payload);
    });
    // Deliberately not forwarding "close": one port going away doesn't close
    // the hub.
    child.on("message", (message) => this.emit("message", message));

    if (this.peerId) child.connect(this.peerId, this.peerMetadata);
    else this.#waiting.push(child);

    return () => this.#drop(child);
  }

  #drop(child: MessageChannelNetworkAdapter): void {
    if (!this.#children.delete(child)) return;
    const waiting = this.#waiting.indexOf(child);
    if (waiting !== -1) this.#waiting.splice(waiting, 1);
    // Emits peer-disconnected, which tears the peer's transport down.
    try {
      child.disconnect();
    } catch {}
  }

  send(message: Message): void {
    // Through the interface: the concrete adapter narrows `send` to the repo's
    // own message union, and subduction frames carry their own type.
    const child: NetworkAdapterInterface | undefined = this.#byPeer.get(
      message.targetId
    );
    child?.send(message);
  }

  disconnect(): void {
    for (const child of [...this.#children]) this.#drop(child);
    this.emit("close");
  }
}
