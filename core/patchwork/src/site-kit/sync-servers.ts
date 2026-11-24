import type { PatchworkSiteOptions } from "./options.js";
import type { ArkVersion } from "@inkandswitch/patchwork-bootloader/keyhive-sync-server";

// The same defaults as the bootloader's DEFAULT_CLASSIC_SYNC_SERVER
// (sync-config.ts) and the subduction url in automerge-protocol-handler.ts,
// as plain strings: this only needs the hosts, not the browser code.
export const DEFAULT_SYNC_SERVERS = {
  classic: "wss://sync3.automerge.org",
  subduction: "wss://subduction.sync.inkandswitch.com",
};

/** Sync servers still running ARK 0.6, by host. */
const ARK_06_HOSTS = ["subduction.sync.inkandswitch.com"];

export function resolvePrimarySyncServer(options: PatchworkSiteOptions): {
  url: string;
  keyhive?: boolean;
  useIdFactory?: boolean;
  ark?: ArkVersion;
} {
  const url =
    (options.syncServers || undefined)?.subduction ??
    DEFAULT_SYNC_SERVERS.subduction;
  if (!options.keyhive) return { url };
  const keyhive = options.keyhive === true ? {} : options.keyhive;
  return {
    url,
    keyhive: true,
    useIdFactory: keyhive.useIdFactory ?? true,
    ark:
      keyhive.ark ?? (ARK_06_HOSTS.includes(new URL(url).host) ? "0.6" : "0.8"),
  };
}

function wsToHttpOrigin(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/**
 * The sync-server origins this build talks to: the subduction server (which
 * keyhive uses too) and, unless it's turned off, the classic one, which only
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

// Emitted by importmap-plugin.ts. keyhive_wasm.wasm is loaded lazily (only
// when keyhive is actually enabled), so it isn't worth an eager preload.
export const PRELOAD_WASM_ASSETS = ["automerge.wasm", "subduction.wasm"];
