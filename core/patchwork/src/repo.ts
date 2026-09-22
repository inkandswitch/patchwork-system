import { initializeWasm, Repo } from "@automerge/vanillajs/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { siblingAdapters } from "@inkandswitch/patchwork-bootloader/siblings";
import { loadOrCreateSigner } from "@inkandswitch/patchwork-bootloader/signer";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import {
  initKeyhiveWasm,
  initializeAutomergeRepoKeyhive,
  type AutomergeRepoKeyhive,
  type SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
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

export type TabRepo = {
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
  signerIdentity?: SignerIdentity;
};

/**
 * The tab's own node: this origin's IndexedDB, opened on this thread, a socket
 * to the sync server, and the siblings channel to every other Repo on the
 * origin. Nothing is shared with other tabs except the database underneath
 * and the identity every node on the origin signs with.
 */
export async function createRepo(): Promise<TabRepo> {
  if (syncServer.keyhive) {
    log("setting up keyhive");
    initKeyhiveWasm();
    const { hive, repo } = await initializeAutomergeRepoKeyhive({
      // ARK injects an `idFactory` deriving document ids from keyhive. A site
      // can opt out of it with `keyhive: { useIdFactory: false }`.
      createRepo: ({ idFactory, ...repoConfig }) =>
        new Repo(
          syncServer.useIdFactory === false
            ? repoConfig
            : { ...repoConfig, idFactory }
        ),
      storage: new IndexedDBStorageAdapter(keyhiveStorageName),
      peerIdSuffix: storagePrefix + Math.random().toString(36).slice(2),
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      // ARK selects the relay via `syncServer`, defaulting to "subduction".
      syncServer: syncServer.keyhive,
      repo: {
        storage: new IndexedDBStorageAdapter(),
        subductionWebsocketEndpoints: [syncServer.url],
        subductionAdapters: siblingAdapters(),
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
    subductionAdapters: siblingAdapters(),
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
