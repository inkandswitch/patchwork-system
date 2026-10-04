declare const __STORAGE_PREFIX__: string;

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
 * The keyhive version this build stores state for. Keyhive versions can't read
 * each other's state, so each gets its own database; `${storagePrefix}-keyhive`
 * (no version) holds the state written by automerge-repo-keyhive 0.5.
 */
export const keyhiveStorageVersion = "0.6";

export const keyhiveStorageName = `${storagePrefix}-keyhive-${keyhiveStorageVersion}`;
