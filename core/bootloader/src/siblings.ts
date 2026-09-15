import type { RepoConfig } from "@automerge/automerge-repo/slim";
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
 * A BroadcastChannel is a mesh in which every node sees every other one, and
 * Subduction's handshake has an initiator and a responder, so the role is
 * "mesh": for each pair, the node whose peer id sorts lower speaks first.
 */
export function siblingAdapters(): SubductionAdapters {
  const serviceName = `${storagePrefix}-siblings`;
  return [
    {
      adapter: new BroadcastChannelNetworkAdapter({ channelName: serviceName }),
      serviceName,
      role: "mesh",
    },
  ];
}
