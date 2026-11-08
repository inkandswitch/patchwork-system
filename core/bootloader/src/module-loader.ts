// The main thread's side of module-loader-worker.ts. The ModuleWatcher uses
// `importAutomergePackageViaWorker` in place of importing a package here: the
// worker says which plugins it exports, and each plugin's `load()` imports
// the package on this thread (at the same heads) and runs the real loader.

import { importPluginFromFolderDocUrl } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { MODULE_LOADER_WORKER } from "./emitted.js";

type Descriptor = Record<string, unknown> & { id?: string; type?: string };

type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: Descriptor[] }
  | { type: "error"; id: number; error: string };

// Importing a package can sync its documents first, which on a slow
// connection takes a while; a minute is well past that, so a request that's
// still waiting then is never going to be answered.
const REQUEST_TIMEOUT_MS = 60_000;

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  {
    worker: Worker;
    timer: ReturnType<typeof setTimeout>;
    resolve: (d: Descriptor[]) => void;
    reject: (e: Error) => void;
  }
>();

function settle(id: number) {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  return entry;
}

// A worker that errored may have lost every request sent to it, and can't be
// trusted with the next, so drop it and fail what was waiting on it. The next
// request spawns a fresh one.
function dropWorker(dead: Worker, error: Error) {
  if (worker === dead) worker = undefined;
  dead.terminate();
  for (const [id, entry] of [...pending]) {
    if (entry.worker === dead) settle(id)?.reject(error);
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  const spawned = new Worker(MODULE_LOADER_WORKER, {
    type: "module",
    name: "patchwork-module-loader",
  });
  worker = spawned;
  spawned.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if (!data || (data.type !== "descriptors" && data.type !== "error")) return;
    const entry = settle(data.id);
    if (!entry) return;
    if (data.type === "descriptors") entry.resolve(data.descriptors);
    else entry.reject(new Error(data.error));
  });
  // An uncaught worker error can't be tied to a single request, so every
  // request outstanding on it fails and callers don't hang.
  spawned.addEventListener("error", (event) => {
    dropWorker(
      spawned,
      new Error(`module-loader worker error: ${event.message ?? "unknown"}`)
    );
  });
  spawned.addEventListener("messageerror", () => {
    dropWorker(
      spawned,
      new Error("module-loader worker sent an unreadable reply")
    );
  });
  return spawned;
}

function discoverDescriptors(urlAtHeads: AutomergeUrl): Promise<Descriptor[]> {
  const id = nextRequestId++;
  return new Promise<Descriptor[]>((resolve, reject) => {
    const target = getWorker();
    const timer = setTimeout(() => {
      settle(id)?.reject(
        new Error(
          `module-loader worker timed out after ${REQUEST_TIMEOUT_MS / 1000}s on ${urlAtHeads}`
        )
      );
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { worker: target, timer, resolve, reject });
    try {
      target.postMessage({ type: "discover", id, url: urlAtHeads });
    } catch (error) {
      dropWorker(
        target,
        error instanceof Error ? error : new Error(String(error))
      );
    }
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
