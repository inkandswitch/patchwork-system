// See docs/bootloader.html#public-reader.
import { initializeWasm } from "@automerge/automerge/slim";
// eslint-disable-next-line
// @ts-ignore — the default init is a wasm-bindgen runtime helper not in the .d.ts
import initSubduction from "@automerge/automerge-subduction/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import debug from "debug";

import { startWorkerControl } from "./worker-control.js";
import { AUTOMERGE_WASM, SUBDUCTION_WASM } from "./emitted.js";
import { keyhiveSyncServer, type ArkVersion } from "./keyhive-sync-server.js";
import { publicReaderStorageName } from "./storage.js";
import { PUBLIC_READER_LOCK } from "./types.js";
import {
  PATCHWORK_PUBLIC_PAIR,
  publicPairId,
} from "./public-pair-principals.js";
import type { PublicReader, PublicReaderStatus } from "./public-pair.js";

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: boolean;
  ark?: ArkVersion;
};

const syncServer =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };

// Every tab is told how far the reader has got, for its loading screen: on
// connecting, and whenever that changes.
const tabs = new Set<MessagePort>();
let status: PublicReaderStatus | undefined;

function tellTabs() {
  if (!status) return;
  for (const port of tabs) port.postMessage({ type: "status", status });
}

const control = startWorkerControl("public-reader-worker", {
  lock: PUBLIC_READER_LOCK,
  onConnect(port) {
    tabs.add(port);
    if (status) port.postMessage({ type: "status", status });
  },
  onClose(port) {
    tabs.delete(port);
  },
  onMessage(data) {
    if (data?.type === "client" && data.port instanceof MessagePort) {
      void serve(data.port);
    } else if (data?.type === "debug-namespaces") {
      // `debug` reads localStorage, which a SharedWorker doesn't have, so the
      // reader's own logs follow the tab's config.
      debug.enable(typeof data.namespaces === "string" ? data.namespaces : "");
      // It took console.debug before startWorkerControl wrapped it to forward.
      debug.log = (...args: unknown[]) => console.debug(...args);
    }
  },
});
const log = control.log;

let readerPromise: Promise<PublicReader> | undefined;

function getReader(): Promise<PublicReader> {
  if (!readerPromise) {
    readerPromise = start();
    readerPromise.catch((error) =>
      control.fail("the public reader failed to start", error)
    );
  }
  return readerPromise;
}

async function start(): Promise<PublicReader> {
  const began = performance.now();
  log("fetching wasm");
  await Promise.all([
    initializeWasm(new Request(AUTOMERGE_WASM)),
    initSubduction(new Request(SUBDUCTION_WASM)),
  ]);
  const { initKeyhiveWasm } = await import("@automerge/automerge-repo-keyhive");
  initKeyhiveWasm();
  const { startPublicReader } = await import("./public-pair.js");
  const storage = new IndexedDBStorageAdapter(
    publicReaderStorageName(publicPairId(PATCHWORK_PUBLIC_PAIR))
  );
  const reader = await startPublicReader({
    url: syncServer.url,
    syncServer: await keyhiveSyncServer(syncServer, storage),
    storage,
    onStatus(next) {
      status = next;
      tellTabs();
    },
  });
  (self as any).reader = reader;
  log(`public reader ready after ${Math.round(performance.now() - began)}ms`);
  return reader;
}

async function serve(port: MessagePort) {
  try {
    (await getReader()).serve(port);
  } catch {
    // the start failing is reported, and restarts this worker
    port.close();
  }
}

// A tab only starts this worker for a build whose sync server has a public
// pair, so start catching up now rather than when the first client arrives.
void getReader();
