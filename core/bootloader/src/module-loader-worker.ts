// Dedicated module worker for plugin-descriptor discovery and datatype init.
//
// A module-settings doc lists Automerge folder-doc packages. To register the
// plugins a package provides we only need their *descriptions* (id, type,
// name, icon…), not their implementations. This worker imports a package's
// entry point off the main thread purely to read its exported `plugins` array,
// strips the non-cloneable `load()` / `import` machinery, and posts the plain
// descriptors back. The main thread re-imports the package (at the same heads)
// only when a plugin is actually loaded — see `importPluginFromFolderDocUrl`.
//
// Created with type:"module"; its dynamic `import()` of `/<automergeUrl>/…`
// entry points is served by the service worker that controls this worker.

import {
  importPackage,
  importPackageFromFolderDocUrl,
} from "@inkandswitch/patchwork-filesystem";
import * as Automerge from "@automerge/automerge/slim";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  initializeWasm,
  MessageChannelNetworkAdapter,
  Repo,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
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
import { keyhiveStorageName, storagePrefix } from "./storage.js";

type DiscoverRequest = {
  type: "discover";
  id: number;
  url: AutomergeUrl;
  importMap?: ImportMap;
  baseURI?: string;
};

type InitDatatypeRequest = {
  type: "init-datatype";
  id: number;
  importUrl: string;
  datatypeId: string;
  importMap?: ImportMap;
  baseURI?: string;
};

type ImportMap = {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
};

declare const __SYNC_SERVER__: {
  url: string;
  keyhive?: SyncServerSelection;
};
const syncServer =
  typeof __SYNC_SERVER__ !== "undefined"
    ? __SYNC_SERVER__
    : { url: "wss://subduction.sync.inkandswitch.com" };
const ES_MODULE_SHIMS_URL =
  "https://ga.jspm.io/npm:es-module-shims@2.8.1/dist/es-module-shims.wasm.js";
let importMapReady: Promise<void> | undefined;
let wasmReady: Promise<void> | undefined;

// Keep only the structured-cloneable description fields. `load` is a closure
// and `module` is the (possibly already-loaded) implementation — neither can
// cross the worker boundary. `import` is droppable too: the main thread
// rebuilds loading by re-importing the package and calling the live plugin.
function toDescriptor(plugin: any): Record<string, unknown> {
  if (!plugin || typeof plugin !== "object") return {};
  const { load, import: _import, module, ...description } = plugin;
  return description;
}

function isDiscoverRequest(data: unknown): data is DiscoverRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).type === "discover" &&
    typeof (data as any).id === "number" &&
    typeof (data as any).url === "string"
  );
}

function isInitDatatypeRequest(data: unknown): data is InitDatatypeRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).type === "init-datatype" &&
    typeof (data as any).id === "number" &&
    typeof (data as any).importUrl === "string" &&
    typeof (data as any).datatypeId === "string"
  );
}

function resolveImportMap(importMap: ImportMap = {}, baseURI: string): ImportMap {
  const resolved: ImportMap = {};

  if (importMap.imports) {
    resolved.imports = {};
    for (const [key, value] of Object.entries(importMap.imports)) {
      try {
        resolved.imports[key] = new URL(value, baseURI).href;
      } catch {
        resolved.imports[key] = value;
      }
    }
  }

  if (importMap.scopes) {
    resolved.scopes = {};
    for (const [scopeKey, scopeMap] of Object.entries(importMap.scopes)) {
      let resolvedScopeKey: string;
      try {
        resolvedScopeKey = new URL(scopeKey, baseURI).href;
      } catch {
        resolvedScopeKey = scopeKey;
      }
      resolved.scopes[resolvedScopeKey] = {};
      for (const [key, value] of Object.entries(scopeMap)) {
        try {
          resolved.scopes[resolvedScopeKey][key] = new URL(value, baseURI).href;
        } catch {
          resolved.scopes[resolvedScopeKey][key] = value;
        }
      }
    }
  }

  return resolved;
}

async function ensureImportMap(importMap?: ImportMap, baseURI?: string) {
  if (importMapReady) return importMapReady;
  importMapReady = (async () => {
    await import(ES_MODULE_SHIMS_URL);
    if (importMap && baseURI) {
      (self as any).importShim.addImportMap(resolveImportMap(importMap, baseURI));
    }
  })();
  return importMapReady;
}

async function ensureWasm() {
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

async function createWorkerRepo(port: MessagePort): Promise<{
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
}> {
  await ensureWasm();
  const adapter = new MessageChannelNetworkAdapter(port);

  if (syncServer.keyhive) {
    initKeyhiveWasm();
    const { hive, repo } = await initializeAutomergeRepoKeyhiveWithRepo({
      createRepo: (repoConfig) => new Repo(repoConfig),
      storage: new IndexedDBWorkerStorageAdapter(keyhiveStorageName),
      peerIdSuffix: storagePrefix + Math.random().toString(36).slice(2),
      networkAdapter: adapter,
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      onlyShareWithHardcodedServerPeerId: false,
      syncServer: syncServer.keyhive,
      repo: {
        storage: new IndexedDBWorkerStorageAdapter(),
        enableRemoteHeadsGossiping: true,
      },
    });
    return { repo, hive };
  }

  const signer = new MemorySigner();
  return {
    repo: new Repo({
      network: [adapter],
      storage: new IndexedDBWorkerStorageAdapter(),
      signer,
      async sharePolicy(peerId) {
        return peerId.includes("automerge-worker");
      },
      enableRemoteHeadsGossiping: true,
      peerId: `${storagePrefix}-datatype-${crypto.randomUUID()}` as any,
    }),
  };
}

async function discover({ id, url, importMap, baseURI }: DiscoverRequest) {
  await ensureImportMap(importMap, baseURI);
  const mod = await importPackageFromFolderDocUrl(url);
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const descriptors = plugins.map(toDescriptor);
  (self as unknown as Worker).postMessage({
    type: "descriptors",
    id,
    descriptors,
  });
}

async function initDatatype(
  { id, importUrl, datatypeId, importMap, baseURI }: InitDatatypeRequest,
  port: MessagePort | undefined
) {
  if (!port) throw new Error("init-datatype requires a repo port");
  await ensureImportMap(importMap, baseURI);
  const { repo } = await createWorkerRepo(port);
  const mod = await importPackage(importUrl);
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const plugin = plugins.find(
    (candidate) =>
      candidate?.type === "patchwork:datatype" && candidate?.id === datatypeId
  );
  if (!plugin) {
    throw new Error(
      `No plugin "patchwork:datatype:${datatypeId}" exported by ${importUrl}`
    );
  }
  const datatype = (typeof plugin.load === "function"
    ? await plugin.load()
    : typeof plugin.import === "string"
      ? await importPackage(plugin.import)
      : undefined) as { init(doc: any, repo: Repo): void } | undefined;
  if (!datatype) {
    throw new Error(
      `Plugin "patchwork:datatype:${datatypeId}" at ${importUrl} has no load() function or import URL`
    );
  }
  const initialized = Automerge.change(Automerge.from({} as any), (doc: any) => {
    datatype.init(doc, repo);
  });
  (self as unknown as Worker).postMessage({
    type: "datatype",
    id,
    document: initialized,
  });
}

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  const reply = async () => {
    if (isDiscoverRequest(data)) {
      await discover(data);
      return;
    }
    if (isInitDatatypeRequest(data)) {
      await initDatatype(data, event.ports[0]);
    }
  };

  void reply().catch((error) => {
    const id = (data as any)?.id;
    if (typeof id !== "number") throw error;
    (self as unknown as Worker).postMessage({
      type: "error",
      id,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });
});
