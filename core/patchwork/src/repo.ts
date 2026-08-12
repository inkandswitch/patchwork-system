import {
  initializeWasm,
  Repo,
  type AutomergeUrl,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { WorkerSubductionEndpoint } from "@inkandswitch/patchwork-bootloader/worker-link";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import {
  initKeyhiveWasm,
  initializeAutomergeRepoKeyhive,
  type AutomergeRepoKeyhiveBase,
  type SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";
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

/** The bit of the bootloader's automerge worker a Repo needs. */
export type WorkerLink = {
  openPort: () => Promise<MessagePort>;
  onRecreated: (listener: () => void) => () => void;
};

export type TabRepo = {
  repo: Repo;
  hive?: AutomergeRepoKeyhiveBase;
  signerIdentity?: SignerIdentity;
};

export async function createRepo(worker: WorkerLink): Promise<TabRepo> {
  // The tab is a storageless node: the subduction worker holds the IndexedDB
  // and the tab syncs against it over one Subduction transport.
  const endpoint = new WorkerSubductionEndpoint(() => worker.openPort());
  // A dead SharedWorker leaves its ports silent rather than closed, so the
  // reconnect loop is told to give up on the old one.
  worker.onRecreated(() => endpoint.reset());
  const subductionWebsocketEndpoints = [endpoint];

  if (syncServer.keyhive) {
    log("setting up keyhive");
    initKeyhiveWasm();
    const { hive, repo } = await initializeAutomergeRepoKeyhive({
      createRepo: (repoConfig) => new Repo(repoConfig),
      storage: new IndexedDBWorkerStorageAdapter(keyhiveStorageName),
      peerIdSuffix: storagePrefix + Math.random().toString(36).slice(2),
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      // ARK selects the relay via `syncServer`, defaulting to "subduction".
      syncServer: syncServer.keyhive,
      repo: { subductionWebsocketEndpoints },
    });
    log("keyhive setup complete");
    return { repo, hive };
  }

  // The signer is explicit rather than the Repo's internal default so the
  // identity the tab presents in the subduction handshake can be shown on
  // window.patchwork. Keyhive supplies its own.
  const signer = new MemorySigner();
  const repo = new Repo({
    signer,
    subductionWebsocketEndpoints,
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
