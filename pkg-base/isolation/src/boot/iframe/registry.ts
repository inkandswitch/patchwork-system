/**
 * The iframe's plugin registry. Runs inside the sandbox: defined at module scope
 * so tsc checks it, serialized into the srcdoc by ../host/srcdoc.ts, and called
 * from `boot()`.
 *
 * Two-phase because of timing: `plugin-registered` pushes can arrive on the RPC
 * port as soon as it's live (early in boot), but actually registering a plugin
 * needs `importShim` + the plugins module, which don't exist until modules load.
 * So `handle()` queues early arrivals; `start()` (called once the modules are
 * ready) registers the initial set, drains the queue, and switches to live mode
 * where subsequent `handle()` calls register immediately.
 */

import type { RegistryEntry } from "../../types.js";
import type { IframeLog } from "./types.js";

/** The `@inkandswitch/patchwork-plugins` module surface the registry needs. */
interface PatchworkPlugins {
  registerPlugins(plugins: unknown[], importUrl: string): void;
}

/** The es-module-shims importer used to lazy-load a plugin's implementation. */
type ImportShim = (specifier: string) => Promise<any>;

export interface Registry {
  /**
   * Handle an inbound RPC message. Returns true if it was a `plugin-registered`
   * push (and was consumed), false otherwise. Before `start()`, consumed pushes
   * are queued; after, they register immediately.
   */
  handle(event: MessageEvent): boolean;
  /**
   * Register the initial entries, drain any queued pushes, and switch to live
   * mode. Call once, after the runtime modules are loaded.
   */
  start(
    importShim: ImportShim,
    patchworkPlugins: PatchworkPlugins,
    entries: RegistryEntry[] | undefined
  ): void;
}

export function createRegistry(log: IframeLog): Registry {
  // Early `plugin-registered` arrivals wait here until start() runs; null once
  // started (live mode registers immediately instead of queuing).
  let pending: RegistryEntry[] | null = [];
  let importShim: ImportShim;
  let patchworkPlugins: PatchworkPlugins;

  // Register one entry as a lazy-loading plugin. importUrls are `registry--`
  // marker URLs (mapped by the host before boot); the implementation is fetched
  // via importShim only when the plugin is actually used.
  function registerEntry(entry: RegistryEntry) {
    const plugin = {
      ...entry,
      load: entry.importUrl
        ? async () => {
            const mod = await importShim(entry.importUrl!);
            // A module that exports a `plugins` array (the common case) must
            // contain an entry matching this registration's id+type — that entry's
            // own load() is the implementation. If none matches, the module does
            // not provide what this entry claims; fail loudly rather than returning
            // the module namespace object (a non-function), which would surface far
            // downstream as an opaque "module is not a function" mount error.
            if (Array.isArray(mod.plugins)) {
              const match = mod.plugins.find(
                (p: any) => p.id === entry.id && p.type === entry.type
              );
              if (match && typeof match.load === "function") {
                return match.load();
              }
              const available = mod.plugins
                .map((p: any) => `${p.type}:${p.id}`)
                .join(", ");
              throw new Error(
                `plugin ${entry.type}:${entry.id} not found in module ${entry.importUrl} ` +
                  `(exports: ${available || "none"})`
              );
            }
            // No `plugins` array — a plain module whose default/namespace export is
            // the implementation.
            return mod.default || mod;
          }
        : undefined,
    };
    patchworkPlugins.registerPlugins([plugin], entry.importUrl || "");
  }

  function handle(event: MessageEvent): boolean {
    const msg = event.data;
    if (!msg || msg.type !== "plugin-registered") return false;
    if (pending) {
      pending.push(msg.entry); // not started yet — queue it
    } else {
      log("registering live plugin update:", msg.entry.id);
      registerEntry(msg.entry);
    }
    return true;
  }

  function start(
    shim: ImportShim,
    plugins: PatchworkPlugins,
    entries: RegistryEntry[] | undefined
  ): void {
    importShim = shim;
    patchworkPlugins = plugins;

    if (entries) {
      for (const entry of entries) registerEntry(entry);
      log("plugins registered:", entries.length);
    }

    // Drain pushes that arrived before we were ready, then switch to live mode.
    const queued = pending ?? [];
    pending = null;
    for (const entry of queued) {
      log("registering deferred plugin update:", entry.id);
      registerEntry(entry);
    }
  }

  return { handle, start };
}
