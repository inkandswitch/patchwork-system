// Bytes by their hash, in CacheStorage. Nothing here is trusted: any code on the origin can
// write these caches, so every read is checked against the service worker's index before it's
// served (see pinned.ts). Reads and writes go through this one interface so the bytes can be
// encrypted at rest later.

export interface ContentStore {
  get(hash: string): Promise<Uint8Array | undefined>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  delete(hash: string): Promise<void>;
}

export const CONTENT_CACHE_PREFIX = "patchwork-content-";

/** One store per account, apart from the `patchwork` cache of site pages and assets. */
export const contentCacheName = (acctHash: string) =>
  `${CONTENT_CACHE_PREFIX}${acctHash}`;

/** A store in `cache`, keyed by `<origin>/.content/<hash>`: an internal key, never fetched. */
export function cacheStore(cache: Cache, origin: string): ContentStore {
  const key = (hash: string) => `${origin}/.content/${hash}`;
  return {
    async get(hash) {
      const response = await cache.match(key(hash));
      return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
    },
    async put(hash, bytes) {
      await cache.put(key(hash), new Response(bytes as BlobPart));
    },
    async delete(hash) {
      await cache.delete(key(hash));
    },
  };
}

/**
 * Forget everything stored for an account. There's no sign-out flow; a site calls this from its
 * own. The service worker's index may still name these hashes, which then read as misses.
 */
export function clearAccountStore(acctHash: string): Promise<boolean> {
  return caches.delete(contentCacheName(acctHash));
}
