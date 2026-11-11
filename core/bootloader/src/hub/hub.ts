// The automerge worker's node: the one sedimentree backend on the origin. It
// owns the IndexedDB database (automerge-repo 3 allows one live backend per
// database, so tabs can't each open it as they did on repo 2), the socket to
// the sync server and, on keyhive sites, keyhive. Tabs reach it through a
// PortBackend (see serve.ts); the worker's own Repo, which answers the
// service worker's handoffs, sits on it directly.

import { Repo } from "@automerge/automerge-repo/slim";
import type { SedimentreeBackend } from "@automerge/automerge-repo/sedimentree";
import {
  SubductionBackend,
  type SubductionStorageAdapterInterface,
} from "@automerge/automerge-repo-subduction";
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb";
import { SwitchableNetwork } from "./switchable-network.js";
import { createMemorySigner } from "@automerge/subduction/slim";
import { KeyhiveBackend } from "../keyline/backend.js";
import { serial } from "../keyline/sync.js";
import { openHubKeyhive, type HubKeyhive } from "./keyhive.js";
import {
  openPublicReader,
  RoutingBackend,
  type PublicReader,
} from "./public.js";
import { serveClient, type HubHive } from "./serve.js";

const SEED_KEY = "signer/seed";

/**
 * The keyhive generation a sync server speaks. `"0.8"` is keyhive 0.6 used
 * directly (keyline), which a server serving `/keyhive/contact-card` speaks
 * (staging). `"0.6"` is ARK 0.6 and keyhive 0.3, which
 * subduction.sync.inkandswitch.com still runs. They can't read each other's
 * state, so each keeps its own (`keyhive/*` and `keyhive-0.6/*` in the
 * worker's database).
 */
export type ArkVersion = "0.6" | "0.8";

export type SyncServerConfig = {
  url: string;
  keyhive?: boolean;
  ark?: ArkVersion;
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
    /** Public documents' blobs, fetched as the public pair (keyhive sites). */
    publicDocuments?: SubductionStorageAdapterInterface;
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
  hive?: HubKeyhive;
  publicReader?: PublicReader;
  /** Serve the tab on the other end of `port`; `onGone` once it's gone. */
  serve(port: MessagePort, onGone?: () => void): void;
  /** Store what's pending and stop. */
  close(): Promise<void>;
};

/** The worker's own small key-value store: its signer seed, keyhive's archive. */
export const hubDatabase = (storagePrefix: string) => `${storagePrefix}-hub`;
/** The database the backend stores documents in. */
export const documentsDatabase = (storagePrefix: string) =>
  `${storagePrefix}-documents`;
/** The database public documents (read as the public pair) are stored in. */
export const publicDocumentsDatabase = (storagePrefix: string) =>
  `${storagePrefix}-public-documents`;

/**
 * How long opening a document waits for keyhive's first sync before deciding
 * whose it is (the user's, or public): until then neither may know it.
 */
const ROUTE_WAIT_MS = 15_000;

/** Wasm (automerge, subduction and, on keyhive sites, keyhive) must be initialized first. */
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
  const subduction = new SubductionBackend({
    signer: createMemorySigner(seed),
    storage:
      stores?.documents ??
      new IndexedDBSubductionStorageAdapter({
        database: documentsDatabase(storagePrefix),
      }),
    network: [network],
  });

  let backend: SedimentreeBackend = subduction;
  let hive: HubKeyhive | undefined;
  let publicReader: PublicReader | undefined;
  let tabHive: HubHive | undefined;
  if (syncServer.keyhive && syncServer.ark === "0.6") {
    const { openArk06Keyhive } = await import("./keyhive-ark06.js");
    const h = (hive = await openArk06Keyhive({
      kv,
      seed,
      url: syncServer.url,
      engine: subduction.engine,
      log,
    }));
    network.subscribe((status) => {
      if (status === "connected") void h.sync().catch(() => {});
    });
    backend = new KeyhiveBackend({
      inner: subduction,
      codec: h.codec,
      mint: (records) => h.mint(records),
      onKeyhiveChange: (listener) => h.onChange(listener),
    });
    // keyhive 0.3's world principal is the public: canRead counts it
    tabHive = h;
  } else if (syncServer.keyhive) {
    const run = serial();
    const h = (hive = await openHubKeyhive({
      kv,
      seed,
      url: syncServer.url,
      engine: subduction.engine,
      run,
      log,
    }));
    // keyhive syncs whenever the socket comes (back) up
    network.subscribe((status) => {
      if (status === "connected") void h.sync().catch(() => {});
    });
    const synced = network
      .connected()
      .then(() => h.sync())
      .catch(() => {});
    const user = new KeyhiveBackend({
      inner: subduction,
      codec: h.codec,
      mint: (records) => h.mint(records),
      onKeyhiveChange: (listener) => h.onChange(listener),
    });

    const pub = (publicReader = await openPublicReader({
      url: syncServer.url,
      serverCard: h.serverCard,
      kv,
      documents:
        stores?.publicDocuments ??
        new IndexedDBSubductionStorageAdapter({
          database: publicDocumentsDatabase(storagePrefix),
        }),
      run,
      log,
    }));
    const bothSynced = Promise.race([
      Promise.all([synced, pub.synced]),
      new Promise((resolve) => setTimeout(resolve, ROUTE_WAIT_MS)),
    ]);
    backend = new RoutingBackend(user, pub.backend, async (id) => {
      await bothSynced;
      return !(await h.canRead(id)) && (await pub.canRead(id));
    });
    // what tabs hear: the user's access, or the public's
    tabHive = {
      id: h.id,
      canRead: async (id) => (await h.canRead(id)) || (await pub.canRead(id)),
      canWrite: (id) => h.canWrite(id),
      onChange(listener) {
        const offUser = h.onChange(listener);
        const offPublic = pub.onChange(listener);
        return () => {
          offUser();
          offPublic();
        };
      },
    };
  }

  const repo = new Repo({ backend });
  log("hub ready as", subduction.peerId, hive ? `keyhive ${hive.id}` : "");

  return {
    backend,
    repo,
    network,
    peerId: subduction.peerId,
    hive,
    publicReader,
    serve: (port, onGone) =>
      serveClient(port, {
        backend,
        peerId: subduction.peerId,
        hive: tabHive,
        log,
        onGone,
        status: {
          peers: () => subduction.engine.getConnectedPeerIds(),
          setOffline: async (offline) => {
            await Promise.all([
              network.setOffline(offline),
              publicReader?.network.setOffline(offline),
            ]);
          },
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
      // keyhive unhooks from the engine, which shutting the Repo down frees
      await Promise.all([hive?.close(), publicReader?.close()]);
      await repo.shutdown();
      if ("close" in kv && typeof kv.close === "function") await kv.close();
    },
  };
}

/**
 * The seed every identity this worker has is made from: its subduction
 * signer and, on keyhive sites, its keyhive signer. Kept so the device stays
 * the same peer across restarts. Only the worker holding the automerge lock
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
