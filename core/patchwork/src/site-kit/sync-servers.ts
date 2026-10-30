import type { PatchworkSiteOptions } from "./options.js";

// Mirrors core/bootloader/src/sync-config.ts's DEFAULT_CLASSIC_SYNC_SERVER
// and automerge-protocol-handler-worker.ts's SUBDUCTION_SYNC_URL selection —
// kept here as plain constants (rather than importing those runtime modules)
// since this only needs the hostnames, not the browser-only logic that reads
// them.
export const DEFAULT_SYNC_SERVERS = {
  classic: "wss://sync3.automerge.org",
  subduction: "wss://subduction.sync.inkandswitch.com",
};

export function resolvePrimarySyncServer(options: PatchworkSiteOptions): {
  url: string;
  keyhive?: boolean;
  useIdFactory?: boolean;
} {
  const url =
    (options.syncServers || undefined)?.subduction ??
    DEFAULT_SYNC_SERVERS.subduction;
  if (!options.keyhive) return { url };
  const keyhive = options.keyhive === true ? {} : options.keyhive;
  return { url, keyhive: true, useIdFactory: keyhive.useIdFactory ?? true };
}

function wsToHttpOrigin(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/**
 * Resolves which sync-server origins are actually live for this build: the
 * channel that's live is subduction xor keyhive plus classic (on-demand,
 * but still worth a preconnect hint) unless disabled.
 */
export function resolveSyncServers(options: PatchworkSiteOptions): string[] {
  if (options.syncServers === false) return [];
  const primary = resolvePrimarySyncServer(options);
  const classic = options.syncServers?.classic ?? DEFAULT_SYNC_SERVERS.classic;
  const origins = [primary.url];
  if (classic) origins.push(classic);
  return origins.map(wsToHttpOrigin);
}

// Emitted by importmap-plugin.ts. keyhive_wasm.wasm is loaded lazily (only
// when keyhive is actually enabled), so it isn't worth an eager preload.
export const PRELOAD_WASM_ASSETS = ["automerge.wasm", "subduction.wasm"];
