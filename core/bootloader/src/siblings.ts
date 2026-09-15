import { NetworkAdapter } from "@automerge/automerge-repo/slim";
import type {
  Message,
  NetworkAdapterInterface,
  PeerId,
  PeerMetadata,
  RepoConfig,
} from "@automerge/automerge-repo/slim";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { storagePrefix } from "./storage.js";

type SubductionAdapters = NonNullable<RepoConfig["subductionAdapters"]>;

/**
 * Every Repo on this origin — each tab's, and the automerge protocol handler
 * worker's — is a full Subduction node with its own storage and its own
 * sync-server socket. Siblings would still meet through the server,
 * eventually; this meets them over a BroadcastChannel so an edit in one tab
 * lands in the others in the time it takes to post a message, online or not.
 *
 * What crosses the channel is Subduction: transport frames between two nodes,
 * authenticated by each one's signer. No classic automerge sync runs here, so
 * the adapters go to `new Repo({ subductionAdapters })` rather than to the
 * network subsystem.
 *
 * Subduction's handshake has an initiator and a responder, but a
 * BroadcastChannel is a mesh in which every node sees every other one. So a
 * single channel is presented as two adapters: the connecting half surfaces
 * only the peers whose peer id sorts above ours, the accepting half only
 * those below. Both ends of any pair agree on which of them speaks first.
 */
export function siblingAdapters(): SubductionAdapters {
  const serviceName = `${storagePrefix}-siblings`;
  const channel = new BroadcastChannelNetworkAdapter({
    channelName: serviceName,
  });
  const shared: SharedChannel = { channel };
  return [
    { adapter: new SiblingHalf(shared, true), serviceName, role: "connect" },
    { adapter: new SiblingHalf(shared, false), serviceName, role: "accept" },
  ];
}

type SharedChannel = {
  channel: NetworkAdapterInterface;
  peerId?: PeerId;
  connected?: boolean;
};

class SiblingHalf extends NetworkAdapter {
  #shared: SharedChannel;
  #initiate: boolean;

  constructor(shared: SharedChannel, initiate: boolean) {
    super();
    this.#shared = shared;
    this.#initiate = initiate;
    const { channel } = shared;
    channel.on("message", (message) => this.emit("message", message));
    channel.on("peer-disconnected", (peer) =>
      this.emit("peer-disconnected", peer)
    );
    channel.on("close", () => this.emit("close"));
    channel.on("peer-candidate", (peer) => {
      if (shared.peerId! < peer.peerId === this.#initiate) {
        this.emit("peer-candidate", peer);
      }
    });
  }

  state() {
    return this.#shared.channel.state();
  }

  isReady() {
    return this.#shared.channel.isReady();
  }

  whenReady() {
    return this.#shared.channel.whenReady();
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId;
    this.#shared.peerId = peerId;
    if (this.#shared.connected) return;
    this.#shared.connected = true;
    this.#shared.channel.connect(peerId, peerMetadata);
  }

  send(message: Message) {
    this.#shared.channel.send(message);
  }

  disconnect() {
    if (!this.#shared.connected) return;
    this.#shared.connected = false;
    this.#shared.channel.disconnect();
  }
}
