declare const __STORAGE_PREFIX__: string;
declare const __SYNC_SERVER__: { ark?: "0.6" | "0.8" };

export const DEFAULT_STORAGE_PREFIX = "patchwork";

/**
 * Namespace for this site's IndexedDB databases and peer ids. The tab and the
 * shared automerge worker are separate bundles that must open the same
 * databases, and this module is the single place either of them gets the name.
 */
export const storagePrefix =
  typeof __STORAGE_PREFIX__ !== "undefined"
    ? __STORAGE_PREFIX__
    : DEFAULT_STORAGE_PREFIX;

/**
 * The automerge-repo-keyhive version this build stores keyhive state for,
 * which is the ARK the build was made with (`keyhive.ark`). Versions can't
 * read each other's state, so each gets its own database;
 * `${storagePrefix}-keyhive` (no version) holds the state written by 0.5.
 */
export const keyhiveStorageVersion: "0.6" | "0.8" =
  (typeof __SYNC_SERVER__ !== "undefined" && __SYNC_SERVER__.ark) || "0.8";

export const keyhiveStorageName = `${storagePrefix}-keyhive-${keyhiveStorageVersion}`;
