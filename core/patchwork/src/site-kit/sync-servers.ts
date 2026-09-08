import type { PatchworkSiteOptions } from "./options.js";
import type { SyncServerSelection } from "@automerge/automerge-repo-keyhive";

// Mirrors core/bootloader/src/sync-config.ts's DEFAULT_CLASSIC_SYNC_SERVER
// and automerge-worker.ts's SUBDUCTION_SYNC_URL selection — kept here as
// plain constants (rather than importing those runtime modules) since this
// only needs the hostnames, not the browser-only logic that reads them.
export const DEFAULT_SYNC_SERVERS = {
  classic: "wss://sync3.automerge.org",
  subduction: "wss://subduction.sync.inkandswitch.com",
  keyhive: "wss://keyhive.sync.automerge.org",
};

export function resolvePrimarySyncServer(options: PatchworkSiteOptions): {
  url: string;
  keyhive?: SyncServerSelection;
  connectSubductionAfterStorageLoad?: boolean;
} {
  const servers = options.syncServers || undefined;
  if (servers?.keyhive) {
    if (typeof servers.keyhive === "string") {
      return {
        keyhive: servers.keyhive,
        url: DEFAULT_SYNC_SERVERS[servers.keyhive],
        connectSubductionAfterStorageLoad:
          servers.connectSubductionAfterStorageLoad ?? true,
      };
    }
    const { url, ...identity } = servers.keyhive;
    return {
      keyhive: identity,
      url,
      connectSubductionAfterStorageLoad:
        servers.connectSubductionAfterStorageLoad ?? true,
    };
  }
  return {
    url: servers?.subduction ?? DEFAULT_SYNC_SERVERS.subduction,
    connectSubductionAfterStorageLoad:
      servers?.connectSubductionAfterStorageLoad ?? true,
  };
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
  const origins = primary.connectSubductionAfterStorageLoad
    ? []
    : [primary.url];
  if (classic) origins.push(classic);
  return origins.map(wsToHttpOrigin);
}

// Emitted by importmap-plugin.ts. keyhive_wasm.wasm is loaded lazily (only
// when keyhive is actually enabled), so it isn't worth an eager preload.
export const PRELOAD_WASM_ASSETS = ["automerge.wasm", "subduction.wasm"];
