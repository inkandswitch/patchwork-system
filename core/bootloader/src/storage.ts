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

export const keyhiveStorageName = `${storagePrefix}-keyhive`;
