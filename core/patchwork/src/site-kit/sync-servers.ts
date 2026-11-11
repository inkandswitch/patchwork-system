import type { PatchworkSiteOptions } from "./options.js";

// The same defaults as the bootloader's DEFAULT_CLASSIC_SYNC_SERVER
// (sync-config.ts) and the subduction url in automerge-protocol-handler.ts,
// as plain strings: this only needs the hosts, not the browser code.
export const DEFAULT_SYNC_SERVERS = {
  classic: "wss://sync3.automerge.org",
  subduction: "wss://subduction.sync.inkandswitch.com",
};

export function resolvePrimarySyncServer(options: PatchworkSiteOptions): {
  url: string;
} {
  const url =
    (options.syncServers || undefined)?.subduction ??
    DEFAULT_SYNC_SERVERS.subduction;
  return { url };
}

function wsToHttpOrigin(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/**
 * The sync-server origins this build talks to: the subduction server and, unless it's turned off, the classic one, which only
 * connects on demand but is still worth a preconnect hint.
 */
export function resolveSyncServers(options: PatchworkSiteOptions): string[] {
  if (options.syncServers === false) return [];
  const primary = resolvePrimarySyncServer(options);
  const classic = options.syncServers?.classic ?? DEFAULT_SYNC_SERVERS.classic;
  const origins = [primary.url];
  if (classic) origins.push(classic);
  return origins.map(wsToHttpOrigin);
}

// Emitted by importmap-plugin.ts.
export const PRELOAD_WASM_ASSETS = ["automerge.wasm"];
