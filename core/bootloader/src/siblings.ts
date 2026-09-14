import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { storagePrefix } from "./storage.js";

/**
 * Every Repo on this origin — each tab's, and the automerge worker's — is a
 * full node with its own storage and its own sync-server socket. Siblings
 * would still meet through the server, eventually; this joins them over a
 * BroadcastChannel with classic automerge sync so an edit in one tab lands in
 * the others in the time it takes to post a message, online or not.
 *
 * On a keyhive site the channel is wrapped in the keyhive adapter, which
 * signs and verifies what crosses it.
 */
export function connectSiblings(repo: Repo, hive?: AutomergeRepoKeyhive) {
  const channel = new BroadcastChannelNetworkAdapter({
    channelName: `${storagePrefix}-siblings`,
  });
  if (!hive) {
    repo.networkSubsystem.addNetworkAdapter(channel);
    return;
  }

  const adapter = hive.createKeyhiveNetworkAdapter(channel, {
    onlyShareWithSyncServer: false,
    periodicallyRequestSync: false,
    syncRequestInterval: 2000,
  });

  adapter.on("message", (msg: any) => {
    if (msg.type !== "sync" && msg.type !== "request") return;
    if (!msg.documentId) return;
    const handle = repo.handles[msg.documentId];
    if (handle && handle.state !== "unavailable") return;
    repo.findWithProgress(`automerge:${msg.documentId}` as AutomergeUrl);
    repo.shareConfigChanged();
  });

  (adapter as any).on("ingest-remote", () => {
    hive.notifySameAgentKeyhiveChange();
    (hive.networkAdapter as any).syncKeyhive?.();
    repo.shareConfigChanged();
  });

  repo.networkSubsystem.addNetworkAdapter(adapter);
}
