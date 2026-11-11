import Debug from "debug";
import * as A from "@automerge/automerge/slim";
import {
  type DocHandle,
  type StorageId,
  type UrlHeads,
  type PeerId,
} from "@automerge/automerge-repo/slim";
import { useRepo, RepoContext } from "solid-automerge";
import {
  createSignal,
  createMemo,
  createEffect,
  on,
  onCleanup,
  untrack,
  Show,
  For,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { getRelativeTimeString } from "./lib/relative-time";
import { Button, Popover, PopoverTrigger, PopoverContent } from "./lib/ui";
import { SyncIcon } from "./SyncIcon";
import { CopyIcon } from "./CopyIcon";
import "./styles.css";

const log = Debug("patchwork:sync-indicator");

export { RepoContext };

interface PeerSyncInfo {
  id: string;
  name: string;
  storageId: StorageId | undefined;
  heads: UrlHeads | undefined;
  lastSyncTimestamp: number | undefined;
  inSync: boolean;
}

function peerName(peerId: PeerId): string {
  if (
    peerId.startsWith("shared-worker") ||
    peerId.startsWith("automerge-worker")
  )
    return "Shared Worker";
  if (peerId.startsWith("service-worker")) return "Service Worker";
  if (peerId.startsWith("storage-server")) return "Sync Server";
  return String(peerId);
}

export function SyncIndicator(props: { handle: DocHandle<unknown> }) {
  const repo = useRepo();
  const [isPopoverOpen, setIsPopoverOpen] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [ownHeads, setOwnHeads] = createSignal<UrlHeads | undefined>();

  // The tab's repo talks to the sync server itself over a Subduction websocket,
  // so connection state and server heads come straight off the repo.
  const [connected, setConnected] = createSignal(repo.isSubductionConnected());
  const [serverPeerIds, setServerPeerIds] = createSignal<string[]>([]);

  const [syncServerHeads, setSyncServerHeads] = createSignal<
    UrlHeads | undefined
  >();
  const [syncServerTimestamp, setSyncServerTimestamp] = createSignal<
    number | undefined
  >();
  const [syncServerStorageId, setSyncServerStorageId] = createSignal<
    StorageId | undefined
  >();

  // classic automerge-sync peers (other tabs, workers)
  const [peers, setPeers] = createStore<PeerSyncInfo[]>([]);

  // The server advertises Subduction *sedimentree* heads, NOT the Automerge
  // frontier, so they can't be compared to ours with A.equals. Ask the handle
  // whether we already hold everything the server advertises instead.
  const containsServerHeads = (heads: UrlHeads | undefined): boolean => {
    if (!heads || heads.length === 0) return false;
    try {
      return props.handle.containsHeads(heads);
    } catch {
      return false;
    }
  };

  /**
   * Trim the sync server's advertised heads for display: drop heads we already
   * hold in our history, keeping our current frontier tip(s) plus any head we
   * genuinely lack. Display only; the synced verdict considers the full set.
   */
  function trimSeenServerHeads(
    heads: UrlHeads | undefined
  ): UrlHeads | undefined {
    if (!heads) return heads;

    let frontier: Set<string>;
    try {
      frontier = new Set<string>([...props.handle.heads()]);
    } catch {
      return heads;
    }

    return heads.filter((h) => {
      if (frontier.has(h)) return true;
      try {
        return !props.handle.containsHeads([h] as UrlHeads);
      } catch {
        return true;
      }
    }) as UrlHeads;
  }

  createEffect(
    on(isPopoverOpen, (open) => {
      if (!open) return;
      untrack(refreshPeers);
      const interval = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(interval));
    })
  );

  const refreshServerPeerIds = () => {
    repo
      .connectedSubductionPeerIds()
      .then(setServerPeerIds)
      .catch((err) => log("connectedSubductionPeerIds failed", err));
  };

  createEffect(() => {
    const onConnection = ({ connected }: { connected: boolean }) => {
      setConnected(connected);
      if (connected) refreshServerPeerIds();
      else setServerPeerIds([]);
    };
    repo.on("subduction-connection", onConnection);
    setConnected(repo.isSubductionConnected());
    refreshServerPeerIds();
    onCleanup(() => repo.off("subduction-connection", onConnection));
  });

  function applySyncServerUpdate(
    storageId: StorageId,
    heads: UrlHeads,
    timestamp: number
  ) {
    setSyncServerStorageId(storageId);
    setSyncServerHeads(heads);
    setSyncServerTimestamp(timestamp);
  }

  createEffect(() => {
    const h = props.handle;

    setOwnHeads(h.heads());

    const onChange = () => {
      if (h.doc()) setOwnHeads(h.heads());
    };

    const updatePeerRow = (idx: number, heads: UrlHeads, timestamp: number) => {
      const currentHeads = ownHeads();
      setPeers(idx, {
        heads,
        lastSyncTimestamp: timestamp,
        inSync: currentHeads ? A.equals(currentHeads, heads) : false,
      });
    };

    const onRemoteHeads = ({
      storageId,
      heads,
      timestamp,
    }: {
      storageId: StorageId;
      heads: UrlHeads;
      timestamp: number;
    }) => {
      log("remote-heads", { storageId, heads, timestamp });
      const idx = peers.findIndex((p) => p.storageId === storageId);
      if (idx >= 0) updatePeerRow(idx, heads, timestamp);
    };

    const onSubductionHeads = (payload: {
      documentId: string;
      storageId: StorageId;
      heads: UrlHeads;
      timestamp: number;
    }) => {
      if (payload.documentId !== h.documentId) return;
      log("subduction-remote-heads", payload);
      const ids = serverPeerIds();
      if (ids.length && !ids.includes(payload.storageId)) return;
      applySyncServerUpdate(payload.storageId, payload.heads, payload.timestamp);
    };

    h.on("change", onChange);
    h.on("remote-heads", onRemoteHeads);
    repo.on("subduction-remote-heads", onSubductionHeads);

    untrack(refreshPeers);

    onCleanup(() => {
      h.off("change", onChange);
      h.off("remote-heads", onRemoteHeads);
      repo.off("subduction-remote-heads", onSubductionHeads);
    });
  });

  // Whatever the repo already knows about the server's heads for this doc
  // (persisted sync info survives reload).
  createEffect(() => {
    const h = props.handle;
    for (const sid of serverPeerIds()) {
      const info = h.getSyncInfo(sid as StorageId);
      if (info?.lastHeads) {
        applySyncServerUpdate(
          sid as StorageId,
          info.lastHeads,
          info.lastSyncTimestamp
        );
      }
    }
  });

  function refreshPeers() {
    const h = props.handle;
    const currentHeads = h.heads();
    const peerList: PeerSyncInfo[] = repo.peers.map((peerId) => {
      const storageId = repo.getStorageIdOfPeer(peerId);
      const syncInfo = storageId ? h.getSyncInfo(storageId) : undefined;
      return {
        id: peerId,
        name: peerName(peerId),
        storageId,
        heads: syncInfo?.lastHeads,
        lastSyncTimestamp: syncInfo?.lastSyncTimestamp,
        inSync:
          syncInfo?.lastHeads && currentHeads
            ? A.equals(currentHeads, syncInfo.lastHeads)
            : false,
      };
    });

    peerList.push({
      id: "sync-server",
      name: "Sync Server",
      storageId: syncServerStorageId(),
      heads: syncServerHeads(),
      lastSyncTimestamp: syncServerTimestamp(),
      inSync: containsServerHeads(syncServerHeads()),
    });

    const peerOrder = (p: PeerSyncInfo) =>
      p.name === "Shared Worker" ? 0 : p.name === "Sync Server" ? 2 : 1;
    peerList.sort((a, b) => peerOrder(a) - peerOrder(b));

    log("peers", peerList);
    setPeers(reconcile(peerList));
  }

  createEffect(() => {
    const currentHeads = ownHeads();
    if (!currentHeads) return;
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      const inSync =
        peer.name === "Sync Server"
          ? containsServerHeads(peer.heads)
          : peer.heads
            ? A.equals(currentHeads, peer.heads)
            : false;
      if (peer.inSync !== inSync) {
        setPeers(i, "inSync", inSync);
      }
    }
  });

  // Single source of truth for "are we up to date with the sync server"; both
  // the icon and the Sync Server row read this memo.
  const syncedToServer = createMemo(() => {
    ownHeads();
    return containsServerHeads(syncServerHeads());
  });

  const syncServerKnown = () => !!syncServerHeads();

  const peerStatusLabel = (peer: PeerSyncInfo) => {
    const inSync = peer.name === "Sync Server" ? syncedToServer() : peer.inSync;
    return inSync ? "synced" : peer.heads ? "behind" : "unknown";
  };

  const serverRowHeads = () => {
    ownHeads();
    return trimSeenServerHeads(syncServerHeads());
  };

  const serverRowTimestamp = () => syncServerTimestamp();

  const displayHeads = (peer: PeerSyncInfo) =>
    peer.name === "Sync Server" ? serverRowHeads() : peer.heads;

  const displayTimestamp = (peer: PeerSyncInfo) =>
    peer.name === "Sync Server" ? serverRowTimestamp() : peer.lastSyncTimestamp;

  const iconState = (): "synced" | "syncing" | "error" | "unknown" => {
    if (!connected()) return "error";
    if (!syncServerKnown()) return "unknown";
    return syncedToServer() ? "synced" : "syncing";
  };

  const statusText = () => {
    if (!connected()) return "Offline";
    if (!syncServerKnown()) return "Connecting…";
    return syncedToServer() ? "Synced to server" : "Syncing…";
  };

  const onCopy = async () => {
    const data = {
      ownHeads: ownHeads(),
      connected: connected(),
      serverPeerIds: serverPeerIds(),
      syncServer: {
        storageId: syncServerStorageId(),
        heads: syncServerHeads(),
        lastSyncTimestamp: syncServerTimestamp(),
        inSync: syncedToServer(),
      },
      peers: peers.map((p) => ({
        name: p.name,
        id: p.id,
        storageId: p.storageId,
        heads: p.heads,
        lastSyncTimestamp: p.lastSyncTimestamp,
        inSync: p.inSync,
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      log("copied sync state to clipboard", data);
    } catch (err) {
      log("failed to copy sync state:", err);
    }
  };

  const relativeTime = (ts: number | undefined) => {
    void now();
    return ts ? getRelativeTimeString(ts) : "-";
  };

  const copyHeads = async (heads: UrlHeads | undefined) => {
    if (!heads) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(heads));
    } catch (err) {
      log("failed to copy heads:", err);
    }
  };

  return (
    <Popover open={isPopoverOpen()} onOpenChange={setIsPopoverOpen}>
      <PopoverTrigger
        class={connected() ? "sync-trigger" : "sync-trigger-offline"}
      >
        <SyncIcon size={20} state={iconState()} />
      </PopoverTrigger>
      <PopoverContent>
        <div class="sync-popover-body">
          <div class="sync-status-header">{statusText()}</div>

          <div class="sync-peers">
            <div
              class="sync-peer sync-peer-clickable"
              onClick={() => copyHeads(ownHeads())}
            >
              <div class="sync-peer-header">
                <span class="sync-peer-name">Tab</span>
              </div>
              <div class="sync-peer-detail">
                heads:{" "}
                {JSON.stringify((ownHeads() ?? []).map((h) => h.slice(0, 6)))}
              </div>
            </div>

            <For each={peers}>
              {(peer) => (
                <div
                  class="sync-peer sync-peer-clickable"
                  onClick={() => copyHeads(displayHeads(peer))}
                >
                  <div class="sync-peer-header">
                    <span class="sync-peer-name">{peer.name}</span>
                    <span class="sync-peer-status">
                      {peerStatusLabel(peer)}
                    </span>
                  </div>
                  <Show when={displayHeads(peer)}>
                    {(heads) => (
                      <div class="sync-peer-detail">
                        heads:{" "}
                        {JSON.stringify(heads().map((h) => h.slice(0, 6)))}
                      </div>
                    )}
                  </Show>
                  <Show when={displayTimestamp(peer)}>
                    <div class="sync-peer-detail">
                      {relativeTime(displayTimestamp(peer))}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>

          <div class="sync-footer">
            <Button onClick={onCopy}>
              <CopyIcon size={14} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const renderSyncIndicator: ToolImplementation = (handle, element) => {
  element.style.width = "fit-content";
  element.style.zIndex = "var(--studio-layer-raised, 10)";

  const dispose = render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <SyncIndicator handle={handle} />
      </RepoContext.Provider>
    ),
    element
  );
  return () => dispose();
};
