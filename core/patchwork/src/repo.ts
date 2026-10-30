import { initializeWasm, Repo } from "@automerge/vanillajs/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { loadOrCreateSigner } from "@inkandswitch/patchwork-bootloader/signer";
import {
  AUTOMERGE_WASM,
  SUBDUCTION_WASM,
} from "@inkandswitch/patchwork-bootloader/emitted";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
// eslint-disable-next-line
// @ts-ignore — the default init is a wasm-bindgen runtime helper not in the .d.ts
import initSubduction from "@automerge/automerge-subduction/slim";
import {
  keyhiveStorageName,
  storagePrefix,
} from "@inkandswitch/patchwork-bootloader/storage";
import { loadSyncServerIdentity } from "@inkandswitch/patchwork-bootloader/keyhive-sync-server";
import type { SignerIdentity } from "./types.js";
import debug from "debug";

const log = debug("patchwork:setup:repo");

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: boolean;
  useIdFactory?: boolean;
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
    wasmReady = Promise.all([
      initializeWasm(new Request(AUTOMERGE_WASM)),
      initSubduction(new Request(SUBDUCTION_WASM)),
    ]).then(() => undefined);
  }
  return wasmReady;
}

/**
 * The BroadcastChannel every Repo on the origin announces its saves and the
 * server's heads on (automerge-repo's `headsChannel`).
 */
export const HEADS_CHANNEL = `${storagePrefix}-heads`;

// Other tabs hear about an edit, and the server is sent it, only once it has
// been saved, so the save throttle (automerge-repo's default is 100ms) is on
// the path from an edit to both.
const SAVE_THROTTLE_MS = 20;

export type TabRepo = {
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
  signerIdentity?: SignerIdentity;
};

/**
 * The tab's own node: this origin's IndexedDB, opened on this thread, a socket
 * to the sync server, and the storage channel to every other Repo on the
 * origin. Nothing is shared with other tabs except the database underneath
 * and the identity every node on the origin signs with.
 */
export async function createRepo(): Promise<TabRepo> {
  if (syncServer.keyhive) {
    log("setting up keyhive");
    const { initKeyhiveWasm, initializeAutomergeRepoKeyhive } =
      await import("@automerge/automerge-repo-keyhive");
    initKeyhiveWasm();
    const keyhiveStorage = new IndexedDBStorageAdapter(keyhiveStorageName);
    const { hive, repo } = await initializeAutomergeRepoKeyhive({
      // ARK injects an `idFactory` deriving document ids from keyhive. A site
      // can opt out of it with `keyhive: { useIdFactory: false }`.
      createRepo: ({ idFactory, ...repoConfig }) =>
        new Repo(
          syncServer.useIdFactory === false
            ? repoConfig
            : { ...repoConfig, idFactory }
        ),
      storage: keyhiveStorage,
      peerIdSuffix: storagePrefix + Math.random().toString(36).slice(2),
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      syncServer: await loadSyncServerIdentity(syncServer.url, keyhiveStorage),
      repo: {
        storage: new IndexedDBStorageAdapter(),
        subductionWebsocketEndpoints: [syncServer.url],
        subductionSaveThrottle: SAVE_THROTTLE_MS,
        headsChannel: HEADS_CHANNEL,
        enableRemoteHeadsGossiping: true,
      },
    });
    log("keyhive setup complete");
    return { repo, hive };
  }

  // The signer is explicit rather than the Repo's internal default so that
  // every tab on this origin signs as the same peer, and so the identity the
  // tab presents to the server can be shown on window.patchwork.
  const storage = new IndexedDBStorageAdapter();
  const signer = await loadOrCreateSigner(storage);
  const repo = new Repo({
    signer,
    storage,
    peerId:
      `${storagePrefix}-tab-${crypto.randomUUID()}` as AutomergeRepo.PeerId,
    subductionWebsocketEndpoints: [syncServer.url],
    subductionSaveThrottle: SAVE_THROTTLE_MS,
    headsChannel: HEADS_CHANNEL,
    enableRemoteHeadsGossiping: true,
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
