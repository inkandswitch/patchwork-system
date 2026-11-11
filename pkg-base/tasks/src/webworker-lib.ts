import type { Repo } from '@automerge/automerge-repo/slim';

const shimCodeUrl = 'https://ga.jspm.io/npm:es-module-shims@1.6.2/dist/es-module-shims.wasm.js';

let importMapReady: Promise<void> | null = null;
let repoModulesReady: Promise<any> | null = null;

export async function setUpImportMap(importMap: any, baseURI: string) {
  if (!importMapReady) {
    importMapReady = (async () => {
      try {
        console.log('importing es-module-shims...');
        await import(shimCodeUrl);
        console.log('done');
      } catch (error) {
        console.error('failed to import es-module-shims:', error);
        throw error;
      }

      (self as any).importShim.addImportMap(resolveImportMap(importMap, baseURI));
    })();
  }

  await importMapReady;
}

function resolveImportMap(importMap: any, baseURI: string) {
  const resolvedImportMap: any = {};

  if (importMap.imports) {
    resolvedImportMap.imports = {};
    for (const [key, value] of Object.entries(importMap.imports)) {
      try {
        resolvedImportMap.imports[key] = new URL(value as any, baseURI).href;
      } catch (e) {
        console.warn(`failed to resolve import map entry ${key}: ${value}`, e);
        resolvedImportMap.imports[key] = value;
      }
    }
  }

  if (importMap.scopes) {
    resolvedImportMap.scopes = {};
    for (const [scopeKey, scopeMap] of Object.entries(importMap.scopes)) {
      let resolvedScopeKey;
      try {
        resolvedScopeKey = new URL(scopeKey, baseURI).href;
      } catch (e) {
        console.warn(`failed to resolve scope key ${scopeKey}`, e);
        resolvedScopeKey = scopeKey;
      }

      resolvedImportMap.scopes[resolvedScopeKey] = {};
      for (const [key, value] of Object.entries(scopeMap as any)) {
        try {
          resolvedImportMap.scopes[resolvedScopeKey][key] = new URL(value as any, baseURI).href;
        } catch (e) {
          console.warn(`failed to resolve scope entry ${scopeKey}[${key}]: ${value}`, e);
          resolvedImportMap.scopes[resolvedScopeKey][key] = value;
        }
      }
    }
  }

  console.log('Import map configured from main thread', resolvedImportMap);
  return resolvedImportMap;
}

export async function getRepo(port: MessagePort, peerId: string) {
  if (!importMapReady) {
    throw new Error('Import map must be configured before creating a worker repo');
  }

  const {
    Repo,
    MessageChannelNetworkAdapter,
    IndexedDBStorageAdapter,
    initializeWasm,
    initSubductionSync,
  } = await getRepoModules();

  const [automergeWasm, subductionWasm] = await Promise.all([
    fetch('/automerge.wasm').then((r) => r.arrayBuffer()),
    fetch('/subduction.wasm').then((r) => r.arrayBuffer()),
  ]);

  initSubductionSync(new Uint8Array(subductionWasm));
  await initializeWasm(new Uint8Array(automergeWasm));
  console.log('Automerge & Subduction WASM initialized');

  const repo = new Repo({
    storage: new IndexedDBStorageAdapter(),
    peerId: peerId as any,
  });

  await connectRepoPort(repo, port);

  (globalThis as any).repo = repo;

  return repo;
}

async function getRepoModules() {
  if (!repoModulesReady) {
    repoModulesReady = (async () => {
      await importMapReady;

      const [automerge, repo, network, storage, subduction] = await Promise.all([
        (self as any).importShim('@automerge/automerge/slim'),
        (self as any).importShim('@automerge/automerge-repo/slim'),
        (self as any).importShim('@automerge/automerge-repo-network-messagechannel'),
        (self as any).importShim('@automerge/automerge-repo-storage-indexeddb'),
        (self as any).importShim('@automerge/automerge-subduction/slim'),
      ]);

      return {
        Repo: repo.Repo,
        MessageChannelNetworkAdapter: network.MessageChannelNetworkAdapter,
        IndexedDBStorageAdapter: storage.IndexedDBStorageAdapter,
        initializeWasm: automerge.initializeWasm,
        initSubductionSync: subduction.initSync,
      };
    })();
  }

  return repoModulesReady;
}

export async function connectRepoPort(repo: Repo, port: MessagePort) {
  const { MessageChannelNetworkAdapter } = await getRepoModules();
  const adapter = new MessageChannelNetworkAdapter(port);
  repo.networkSubsystem.addNetworkAdapter(adapter);
  await adapter.whenReady();
}
