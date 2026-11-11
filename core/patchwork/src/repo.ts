import { initializeWasm } from "@automerge/automerge/slim";
import { Repo } from "@automerge/automerge-repo/slim";
import type { PortBackend } from "@inkandswitch/patchwork-bootloader";
import { AUTOMERGE_WASM } from "@inkandswitch/patchwork-bootloader/emitted";
import { storagePrefix } from "@inkandswitch/patchwork-bootloader/storage";
import type { SignerIdentity } from "./types.js";
import debug from "debug";

const log = debug("patchwork:setup:repo");

// Fetch and initialize automerge's wasm. Memoized: the fetch starts on the
// first call and every later caller awaits the same init. Skipped entirely
// when the site brings its own Repo (it did this itself). A tab needs no
// subduction: it runs in the automerge worker.
let wasmReady: Promise<void> | undefined;
export function initWasm(): Promise<void> {
  wasmReady ??= initializeWasm(new Request(AUTOMERGE_WASM)).then(() => {});
  return wasmReady;
}

export type TabRepo = {
  repo: Repo;
  signerIdentity?: SignerIdentity;
  /** The tab's end of the automerge worker: its Repo's backend. */
  backend: PortBackend;
};

/**
 * The tab's Repo. Everything it stores and syncs goes through the automerge
 * worker, the origin's one node (its IndexedDB, its socket to the sync
 * server): the tab's backend is a port to it, handed to every
 * worker that replaces the last.
 */
export async function createRepo(): Promise<TabRepo> {
  // Imported here: the bootloader's entry touches `window` as it loads, and
  // this module is loaded without one in tests.
  const { PortBackend, connectToAutomergeWorker } =
    await import("@inkandswitch/patchwork-bootloader");
  const lock = await holdLockForever(
    `${storagePrefix}-tab-${crypto.randomUUID()}`
  );
  const backend = new PortBackend(lock);
  const repo = new Repo({ backend });
  connectToAutomergeWorker(backend);

  const info = await backend.info();
  const signerIdentity = { peerId: info.peerId, verifyingKey: info.peerId };
  log("repo created, the worker signs as", info.peerId);
  return { repo, signerIdentity, backend };
}

/**
 * Take a Web Lock named `name` and never let it go: the worker waits on it to
 * learn this tab has gone. Resolves with the name once it's held.
 */
function holdLockForever(name: string): Promise<string> {
  return new Promise((held) => {
    void navigator.locks.request(name, () => {
      held(name);
      return new Promise<never>(() => {});
    });
  });
}
