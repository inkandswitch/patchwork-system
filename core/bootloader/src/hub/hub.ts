// The automerge worker's node: the one sedimentree backend on the origin. It
// owns the IndexedDB database (automerge-repo 3 allows one live backend per
// database, so tabs can't each open it as they did on repo 2) and the socket
// to the sync server. Tabs reach it through a PortBackend (see serve.ts); the
// worker's own Repo, which answers the service worker's handoffs, sits on it
// directly.

import { Repo } from "@automerge/automerge-repo/slim";
import type { SedimentreeBackend } from "@automerge/automerge-repo/sedimentree";
import {
  SubductionBackend,
  type SubductionStorageAdapterInterface,
} from "@automerge/automerge-repo-subduction";
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb";
import { SwitchableNetwork } from "./switchable-network.js";
import { createMemorySigner } from "@automerge/subduction/slim";
import { serveClient } from "./serve.js";

const SEED_KEY = "signer/seed";

/** @deprecated Patchwork no longer uses keyhive. */
export type ArkVersion = "0.6" | "0.8";

export type SyncServerConfig = {
  url: string;
};

export type HubOptions = {
  syncServer: SyncServerConfig;
  /** The site's storage prefix: the worker's databases are named after it. */
  storagePrefix: string;
  log?: (...args: unknown[]) => void;
  /** Where to keep things instead of IndexedDB (tests). */
  stores?: {
    kv: SubductionStorageAdapterInterface;
    documents: SubductionStorageAdapterInterface;
  };
};

export type Hub = {
  /** What tabs and the worker's Repo store and sync through. */
  backend: SedimentreeBackend;
  /** The worker's own Repo. */
  repo: Repo;
  network: SwitchableNetwork;
  /** The hex verifying key the worker signs as, towards the sync server. */
  peerId: string;
  /** Serve the tab on the other end of `port`; `onGone` once it's gone. */
  serve(port: MessagePort, onGone?: () => void): void;
  /** Store what's pending and stop. */
  close(): Promise<void>;
};

/** The worker's own small key-value store: its signer seed. */
export const hubDatabase = (storagePrefix: string) => `${storagePrefix}-hub`;
/** The database the backend stores documents in. */
export const documentsDatabase = (storagePrefix: string) =>
  `${storagePrefix}-documents`;

/** Wasm (automerge and subduction) must be initialized first. */
export async function createHub({
  syncServer,
  storagePrefix,
  log = () => {},
  stores,
}: HubOptions): Promise<Hub> {
  const kv =
    stores?.kv ??
    new IndexedDBSubductionStorageAdapter({
      database: hubDatabase(storagePrefix),
    });
  const seed = await loadOrCreateSeed(kv);
  const network = new SwitchableNetwork(syncServer.url);
  const backend = new SubductionBackend({
    signer: createMemorySigner(seed),
    storage:
      stores?.documents ??
      new IndexedDBSubductionStorageAdapter({
        database: documentsDatabase(storagePrefix),
      }),
    network: [network],
  });

  const repo = new Repo({ backend });
  log("hub ready as", backend.peerId);

  return {
    backend,
    repo,
    network,
    peerId: backend.peerId,
    serve: (port, onGone) =>
      serveClient(port, {
        backend,
        peerId: backend.peerId,
        log,
        onGone,
        status: {
          peers: () => backend.subduction.getConnectedPeerIds(),
          setOffline: (offline) => network.setOffline(offline),
          connected: () => network.status === "connected",
          subscribe: (listener) => {
            let last = network.status === "connected";
            return network.subscribe((s) => {
              if ((s === "connected") !== last)
                listener((last = s === "connected"));
            });
          },
        },
      }),
    async close() {
      await repo.shutdown();
      if ("close" in kv && typeof kv.close === "function") await kv.close();
    },
  };
}

/**
 * The seed this worker's subduction signer is made from. Kept so the device
 * stays the same peer across restarts. Only the worker holding the automerge lock
 * runs this, so two can't race to make one.
 */
async function loadOrCreateSeed(
  kv: SubductionStorageAdapterInterface
): Promise<Uint8Array> {
  const [stored] = await kv.loadMany([SEED_KEY]);
  if (stored) return stored;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  await kv.saveBatch([[SEED_KEY, seed]]);
  return seed;
}
