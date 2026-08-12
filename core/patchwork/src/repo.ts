import {
  initializeWasm,
  MessageChannelNetworkAdapter,
  Repo,
  type AutomergeUrl,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import { WorkerSubductionEndpoint } from "@inkandswitch/patchwork-bootloader/worker-link";
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
  hive?: AutomergeRepoKeyhive;
  signerIdentity?: SignerIdentity;
};

export async function createRepo(worker: WorkerLink): Promise<TabRepo> {
  if (syncServer.keyhive) {
    log("setting up keyhive");
    initKeyhiveWasm();
    let workerAdapter = new MessageChannelNetworkAdapter(
      await worker.openPort()
    );
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
    // A keyhive tab keeps classic sync, so it re-wires itself onto a fresh port
    // when the worker is replaced.
    worker.onRecreated(async () => {
      const fresh = new MessageChannelNetworkAdapter(await worker.openPort());
      const registered = hive.createKeyhiveNetworkAdapter(
        fresh,
        false,
        false,
        2000
      );
      repo.networkSubsystem.addNetworkAdapter(registered as any);
      removeAdapterFor(repo, workerAdapter, registered);
      workerAdapter = fresh;
    });
    await repo.networkSubsystem.whenReady();
    return { repo, hive };
  }

  // The tab is a storageless node: the worker holds the IndexedDB and the tab
  // syncs against it over subduction, one transport per repo port. The signer
  // is explicit rather than the Repo's internal default so the identity the tab
  // presents in that handshake can be shown on window.patchwork.
  const signer = new MemorySigner();
  const endpoint = new WorkerSubductionEndpoint(() => worker.openPort());
  // A dead SharedWorker leaves its ports silent rather than closed, so the
  // reconnect loop is told to give up on the old one.
  worker.onRecreated(() => endpoint.reset());
  const repo = new Repo({
    signer,
    subductionWebsocketEndpoints: [endpoint],
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
