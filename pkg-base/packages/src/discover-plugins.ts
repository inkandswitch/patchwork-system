// Preview a package's plugins WITHOUT registering it: ask the host's shared
// module-loader worker (emitted by the bootloader to /module-loader-worker.js,
// the same one the module-settings-manager uses) to import the package entry
// off-thread and report back plain plugin descriptors over the `discover`
// protocol. We only need the descriptors for the preview card, so — unlike the
// manager's client — we don't rebuild each descriptor's load(); there are no
// external deps here.

import * as filesystem from "@inkandswitch/patchwork-filesystem";
import { isAutomergeUrl } from "./origin.ts";

export interface PluginDescriptor {
  id?: string;
  type?: string;
  name?: string;
  icon?: string;
  supportedDatatypes?: string | string[];
  unlisted?: boolean;
  [key: string]: unknown;
}

type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: PluginDescriptor[] }
  | { type: "error"; id: number; error: string };

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (d: PluginDescriptor[]) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker("/module-loader-worker.js", {
    type: "module",
    name: "packages-module-loader",
  });
  w.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if (!data || (data.type !== "descriptors" && data.type !== "error")) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === "descriptors") entry.resolve(data.descriptors);
    else entry.reject(new Error(data.error));
  });
  w.addEventListener("error", (event) => {
    // An uncaught worker error can't be tied to a request — fail every
    // outstanding one, and drop the worker so the next call respawns it.
    const error = new Error(
      `module-loader worker error: ${event.message ?? "unknown"}`
    );
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
    worker = undefined;
  });
  worker = w;
  return w;
}

type AutomergeImporter = (url: string) => Promise<unknown>;

function hostImporter(): AutomergeImporter | undefined {
  try {
    const watcher = (
      globalThis as {
        window?: {
          patchwork?: { packages?: { importAutomergePackage?: unknown } };
        };
      }
    ).window?.patchwork?.packages;
    const importer = watcher?.importAutomergePackage;
    return typeof importer === "function"
      ? (importer as AutomergeImporter).bind(watcher)
      : undefined;
  } catch {
    return undefined;
  }
}

function discoverViaWorker(
  folderUrl: string,
  timeoutMs: number
): Promise<PluginDescriptor[]> {
  const id = nextRequestId++;
  return new Promise<PluginDescriptor[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("Timed out importing the package"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        resolve(d);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      getWorker().postMessage({ type: "discover", id, url: folderUrl });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Discover the plugins the package at `folderUrl` exports, off-thread. Rejects
 * (rather than hanging) after `timeoutMs`, or if the worker can't be reached at
 * all — callers treat a rejection as "couldn't preview", not "can't install".
 */
export async function discoverPlugins(
  folderUrl: string,
  timeoutMs = 15000
): Promise<PluginDescriptor[]> {
  const importer = hostImporter();
  if (!importer) return discoverViaWorker(folderUrl, timeoutMs);
  const mod = await withTimeout(
    importer(folderUrl),
    timeoutMs,
    "importing the package"
  );
  return descriptorsOf(mod);
}

function descriptorsOf(mod: unknown): PluginDescriptor[] {
  const plugins = (mod as { plugins?: unknown } | undefined)?.plugins;
  return Array.isArray(plugins) ? plugins.map(toDescriptor) : [];
}

// Keep only the structured/cloneable description fields — `load` is a closure,
// `module` the (maybe already-loaded) implementation, `import` a URL the loader
// rebuilds. We only preview the description. Mirrors the host worker's stripping
// so an http descriptor reads the same as a worker-discovered automerge one.
function toDescriptor(plugin: any): PluginDescriptor {
  if (!plugin || typeof plugin !== "object") return {};
  const { load, import: _import, module, ...description } = plugin;
  return description as PluginDescriptor;
}

/** Reject `p` after `ms` rather than let a hung import spin the preview forever. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out ${what}`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Discover the plugins an http(s) package exports by importing its entry module
 * and reading its `plugins` export — the http counterpart to the worker-based
 * automerge discovery, and the same thing the host does for suggested/http
 * modules (`importPackageFromHttpUrl` → `mod.plugins`).
 *
 * It runs on the MAIN thread deliberately: there is no host worker that imports
 * http URLs, and a plain Worker has no importmap to resolve the module's bare
 * deps (solid-js, …). This is the same import installing the package would run,
 * only for preview.
 */
export async function discoverHttpPlugins(
  url: string,
  timeoutMs = 15000
): Promise<PluginDescriptor[]> {
  const mod = await withTimeout(
    filesystem.importPackageFromHttpUrl(url),
    timeoutMs,
    "importing the package"
  );
  return descriptorsOf(mod);
}

/**
 * Discover a package's plugins by URL kind: an automerge folder-doc off-thread
 * via the host worker, an http(s) bundle via a direct main-thread import.
 */
export function discoverPackagePlugins(
  url: string
): Promise<PluginDescriptor[]> {
  return isAutomergeUrl(url) ? discoverPlugins(url) : discoverHttpPlugins(url);
}
