/** localStorage key: optional override for the classic sync WebSocket URL. */
export const CLASSIC_SYNC_SERVER_KEY = "patchworkClassicSyncServer";

declare const __CLASSIC_SYNC_SERVER__: string;

export const DEFAULT_CLASSIC_SYNC_SERVER =
  typeof __CLASSIC_SYNC_SERVER__ !== "undefined"
    ? __CLASSIC_SYNC_SERVER__
    : "wss://sync3.automerge.org";

export function readClassicSyncServer(
  storage: Pick<Storage, "getItem"> = globalThis.localStorage
): string {
  const override = storage.getItem(CLASSIC_SYNC_SERVER_KEY)?.trim();
  if (!override) return DEFAULT_CLASSIC_SYNC_SERVER;
  if (!/^wss?:\/\//.test(override)) {
    console.warn(
      `ignoring invalid ${CLASSIC_SYNC_SERVER_KEY} in localStorage: ${override}; using ${DEFAULT_CLASSIC_SYNC_SERVER}`
    );
    return DEFAULT_CLASSIC_SYNC_SERVER;
  }
  return override;
}
