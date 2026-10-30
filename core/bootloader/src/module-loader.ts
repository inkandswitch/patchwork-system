// Main-thread client for the module-loader worker (see module-loader-worker.ts).
//
// `importAutomergePackageViaWorker` is wired into the ModuleWatcher in place of
// its default (direct, main-thread) package import. It asks the worker to
// import the package entry point and report which plugins it exports, then
// returns the same `{ plugins }` shape the watcher already feeds to
// `registerPlugins` — except each plugin's `load()` re-imports the package
// (pinned to the same heads, or the same pinned `/@/` URL) on this thread and
// runs the real plugin loader.

import { importPluginFromPackage } from "@inkandswitch/patchwork-filesystem";
import { MODULE_LOADER_WORKER } from "./emitted.js";

type Descriptor = Record<string, unknown> & { id?: string; type?: string };

type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: Descriptor[] }
  | { type: "error"; id: number; error: string };

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (d: Descriptor[]) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(MODULE_LOADER_WORKER, {
    type: "module",
    name: "patchwork-module-loader",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if (!data || (data.type !== "descriptors" && data.type !== "error")) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === "descriptors") entry.resolve(data.descriptors);
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

function discoverDescriptors(urlAtHeads: string): Promise<Descriptor[]> {
  const id = nextRequestId++;
  return new Promise<Descriptor[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: "discover", id, url: urlAtHeads });
  });
}

export async function importAutomergePackageViaWorker(
  url: string
): Promise<{ plugins: Descriptor[] }> {
  const descriptors = await discoverDescriptors(url);
  const plugins = descriptors.map((descriptor) => {
    const { id, type } = descriptor;
    // A plugin id is only unique within a plugin type, so both are needed to
    // re-select the right plugin when its load() re-imports the package.
    if (typeof id !== "string" || typeof type !== "string") return descriptor;
    return {
      ...descriptor,
      load: () => importPluginFromPackage(url, type, id),
    };
  });
  return { plugins };
}
