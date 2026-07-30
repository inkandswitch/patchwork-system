import {
  initializeWasm,
  MessageChannelNetworkAdapter,
  Repo,
  type AutomergeUrl,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import {
  initKeyhiveWasm,
  initializeAutomergeRepoKeyhiveWithRepo,
  type AutomergeRepoKeyhive,
  type SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
import setupServiceWorker from "@inkandswitch/patchwork-bootloader";
import {
  keyhiveStorageName,
  storagePrefix,
} from "@inkandswitch/patchwork-bootloader/storage";
import type { SignerIdentity } from "./types.js";
import debug from "debug";

const log = debug("patchwork:setup:repo");

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: SyncServerSelection;
};
const syncServer =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };

// Fetch and initialize automerge + subduction wasm. Memoized: the fetches start
// on the first call and every later caller awaits the same init. Skipped
// entirely when the site brings its own Repo (it did this itself).
let wasmReady: Promise<void> | undefined;
export function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const [automergeWasm, subductionWasm] = await Promise.all([
        fetch("/automerge.wasm").then((r) => r.bytes()),
        fetch("/subduction.wasm").then((r) => r.bytes()),
      ]);
      await initializeWasm(automergeWasm);
      initSubductionSync(subductionWasm);
    })();
  }
  return wasmReady;
}

export async function createRepo(
  workerAdapter: MessageChannelNetworkAdapter
): Promise<{
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
  signerIdentity?: SignerIdentity;
}> {
  if (syncServer.keyhive) {
    log("setting up keyhive");
    initKeyhiveWasm();
    const { hive, repo } = await initializeAutomergeRepoKeyhiveWithRepo({
      createRepo: (repoConfig) => new Repo(repoConfig),
      storage: new IndexedDBWorkerStorageAdapter(keyhiveStorageName),
      peerIdSuffix: storagePrefix + Math.random().toString(36).slice(2),
      networkAdapter: workerAdapter,
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      onlyShareWithHardcodedServerPeerId: false,
      // ARK selects the relay via `syncServer`, defaulting to "subduction".
      syncServer: syncServer.keyhive,
      repo: {
        storage: new IndexedDBWorkerStorageAdapter(),
        enableRemoteHeadsGossiping: true,
      },
    });
    log("keyhive setup complete");
    return { repo, hive };
  }

  // An explicit signer, rather than the Repo's internal default, so the tab's
  // identity can be exposed on window.patchwork. The tab never connects via
  // Subduction, so this id never goes on the wire.
  const signer = new MemorySigner();
  const repo = new Repo({
    network: [workerAdapter],
    storage: new IndexedDBWorkerStorageAdapter(),
    signer,
    async sharePolicy(peerId) {
      return peerId.includes("automerge-worker");
    },
    enableRemoteHeadsGossiping: true,
    peerId:
      `${storagePrefix}-tab-${crypto.randomUUID()}` as AutomergeRepo.PeerId,
  });
  const signerIdentity = {
    peerId: signer.peerId().toString(),
    verifyingKey: (
      signer.verifyingKey() as Uint8Array<ArrayBufferLike> & {
        toHex(): string;
      }
    ).toHex(),
  };
  log("repo created, tab subduction identity:", signerIdentity);
  return { repo, signerIdentity };
}

/**
 * Resolve with the first repo port the worker delivers, calling `onRenewed` for
 * every later one.
 *
 * subscribeToRepoChannel is deliberately not awaited: it resolves only after
 * the boot channel's port-ready handshake, which can take its full 30s timeout
 * against a stranded worker connection. Boot blocks on the first *delivered*
 * port instead — if the boot channel stalls, worker recovery hands the listener
 * a good port long before that timeout.
 */
export function firstRepoPort(
  sw: Awaited<ReturnType<typeof setupServiceWorker>>,
  onRenewed: (port: MessagePort) => void
): Promise<MessagePort> {
  return new Promise<MessagePort>((resolve) => {
    let seen = false;
    void sw.subscribeToRepoChannel((port) => {
      if (seen) return onRenewed(port);
      seen = true;
      resolve(port);
    });
  });
}

/** Drop the adapter sitting on the dead worker port, leaving `keep` in place. */
export function removeAdapterFor(
  repo: Repo,
  stale: MessageChannelNetworkAdapter,
  keep: unknown
): void {
  for (const adapter of [...repo.networkSubsystem.adapters]) {
    if (adapter === keep) continue;
    // The keyhive wrapper keeps the wrapped adapter on `.networkAdapter`.
    const base = (adapter as any).networkAdapter ?? adapter;
    if (base !== stale) continue;
    try {
      repo.networkSubsystem.removeNetworkAdapter(adapter as any);
    } catch (err) {
      console.error("failed to remove stale worker network adapter", err);
    }
  }
}
