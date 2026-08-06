// Main-thread client for the module-loader worker (see module-loader-worker.ts).
//
// `importAutomergePackageViaWorker` is wired into the ModuleWatcher in place of
// its default (direct, main-thread) package import. It asks the worker to
// import the package entry point and report which plugins it exports, then
// returns the same `{ plugins }` shape the watcher already feeds to
// `registerPlugins` — except each plugin's `load()` re-imports the package
// (pinned to the same heads) on this thread and runs the real plugin loader.

import { importPluginFromFolderDocUrl } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

type Descriptor = Record<string, unknown> & { id?: string; type?: string };
type ImportMap = {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
};

type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: Descriptor[] }
  | { type: "datatype"; id: number; bytes: Uint8Array }
  | { type: "error"; id: number; error: string };

const WORKER_PATH = "/module-loader-worker.js";

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (e: Error) => void;
  }
>();

function getResolvedImportMap(): ImportMap {
  const script = document.querySelector('script[type="importmap"]');
  if (!script?.textContent) return {};
  try {
    const raw = JSON.parse(script.textContent) as ImportMap;
    const baseURI = document.baseURI;
    const resolved: ImportMap = {};

    if (raw.imports) {
      resolved.imports = {};
      for (const [key, value] of Object.entries(raw.imports)) {
        try {
          resolved.imports[key] = new URL(value, baseURI).href;
        } catch {
          resolved.imports[key] = value;
        }
      }
    }

    if (raw.scopes) {
      resolved.scopes = {};
      for (const [scopeKey, scopeMap] of Object.entries(raw.scopes)) {
        let resolvedKey: string;
        try {
          resolvedKey = new URL(scopeKey, baseURI).href;
        } catch {
          resolvedKey = scopeKey;
        }
        resolved.scopes[resolvedKey] = {};
        for (const [key, value] of Object.entries(scopeMap)) {
          try {
            resolved.scopes[resolvedKey][key] = new URL(value, baseURI).href;
          } catch {
            resolved.scopes[resolvedKey][key] = value;
          }
        }
      }
    }

    return resolved;
  } catch {
    return {};
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(WORKER_PATH, {
    type: "module",
    name: "patchwork-module-loader",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if (
      !data ||
      (data.type !== "descriptors" &&
        data.type !== "datatype" &&
        data.type !== "error")
    ) {
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === "descriptors") entry.resolve(data.descriptors);
    else if (data.type === "datatype") entry.resolve(data.bytes);
    else entry.reject(new Error(data.error));
  });
  worker.addEventListener("error", (event) => {
    // An uncaught worker error can't be tied to a single request — fail every
    // outstanding one so callers don't hang.
    const error = new Error(
      `module-loader worker error: ${event.message ?? "unknown"}`
    );
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  });
  return worker;
}

function discoverDescriptors(urlAtHeads: AutomergeUrl): Promise<Descriptor[]> {
  const id = nextRequestId++;
  return new Promise<Descriptor[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({
      type: "discover",
      id,
      url: urlAtHeads,
      importMap: getResolvedImportMap(),
      baseURI: document.baseURI,
    });
  });
}

export function initializeDatatypeViaWorker<D>(
  importUrl: string,
  datatypeId: string,
  repoPort: MessagePort
): Promise<D> {
  const id = nextRequestId++;
  const worker = new Worker(WORKER_PATH, {
    type: "module",
    name: `patchwork-datatype-${datatypeId}`,
  });
  return new Promise<D>((resolve, reject) => {
    const cleanup = () => {
      worker.terminate();
      pending.delete(id);
    };
    pending.set(id, {
      resolve(value) {
        cleanup();
        resolve(value as D);
      },
      reject(error) {
        cleanup();
        reject(error);
      },
    });
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const data = event.data;
      if (
        !data ||
        data.id !== id ||
        (data.type !== "datatype" && data.type !== "error")
      ) {
        return;
      }
      const entry = pending.get(id);
      if (!entry) return;
      if (data.type === "datatype") entry.resolve(data.bytes);
      else entry.reject(new Error(data.error));
    });
    worker.addEventListener("error", (event) => {
      const entry = pending.get(id);
      if (!entry) return;
      entry.reject(
        new Error(`datatype worker error: ${event.message ?? "unknown"}`)
      );
    });
    worker.postMessage(
      {
        type: "init-datatype",
        id,
        importUrl,
        datatypeId,
        importMap: getResolvedImportMap(),
        baseURI: document.baseURI,
      },
      [repoPort]
    );
  });
}

export async function importAutomergePackageViaWorker(
  urlAtHeads: string
): Promise<{ plugins: Descriptor[] }> {
  const url = urlAtHeads as AutomergeUrl;
  const descriptors = await discoverDescriptors(url);
  const plugins = descriptors.map((descriptor) => {
    const { id, type } = descriptor;
    // A plugin id is only unique within a plugin type, so both are needed to
    // re-select the right plugin when its load() re-imports the package.
    if (typeof id !== "string" || typeof type !== "string") return descriptor;
    return {
      ...descriptor,
      load: () => importPluginFromFolderDocUrl(url, type, id),
    };
  });
  return { plugins };
}
