import {
  initializeWasm,
  Repo,
  type AutomergeUrl,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import {
  PortHubAdapter,
  WORKER_SUBDUCTION_SERVICE,
} from "@inkandswitch/patchwork-bootloader/port-hub";
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

export type TabRepo = {
  repo: Repo;
  hive?: AutomergeRepoKeyhiveBase;
  signerIdentity?: SignerIdentity;
  /** Wire the repo onto a port from a freshly recreated automerge worker. */
  rewire(port: MessagePort): void;
  /** Resolves once the worker has answered on some port. */
  linked(): Promise<void>;
};

export async function createRepo(workerPort: MessagePort): Promise<TabRepo> {
  // The tab is a storageless node: the worker holds the IndexedDB and the tab
  // syncs against it over subduction, one transport per repo port. The hub
  // outlives any single port, so a recreated worker just hands over a new one.
  const link = new PortHubAdapter();
  let dropWorkerPort = link.addPort(workerPort);
  const subductionAdapters = [
    {
      adapter: link,
      serviceName: WORKER_SUBDUCTION_SERVICE,
      role: "connect" as const,
    },
  ];
  const linked = () => link.whenReady();
  const rewire = (port: MessagePort) => {
    dropWorkerPort();
    dropWorkerPort = link.addPort(port);
  };

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
      repo: { subductionAdapters },
    });
    log("keyhive setup complete");
    return { repo, hive, linked, rewire };
  }

  // The signer is explicit rather than the Repo's internal default so the
  // identity the tab presents in the subduction handshake can be shown on
  // window.patchwork. Keyhive supplies its own.
  const signer = new MemorySigner();
  const repo = new Repo({
    signer,
    subductionAdapters,
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
  return { repo, signerIdentity, linked, rewire };
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
