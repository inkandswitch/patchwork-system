import { describe, it, expect } from "vitest";
import { cacheStore } from "../src/content-store.js";
import { contentHash, toBytes } from "../src/content-hash.js";

/** Enough of Cache for the store: put, match and delete by url. */
export class FakeCache {
  entries = new Map<string, Response>();
  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(new Request(request).url, response.clone());
  }
  async match(request: RequestInfo | URL) {
    return this.entries.get(new Request(request).url)?.clone();
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(new Request(request).url);
  }
}

describe("contentHash", () => {
  it("is base64url sha-256 without padding", async () => {
    // sha256("") = e3b0c442…b855
    expect(await contentHash(new Uint8Array())).toBe(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
    );
  });

  it("hashes strings as UTF-8", async () => {
    expect(await contentHash(toBytes("héllo ✓"))).toBe(
      await contentHash(new TextEncoder().encode("héllo ✓"))
    );
  });
});

describe("cacheStore", () => {
  it("round-trips bytes under /.content/<hash>", async () => {
    const cache = new FakeCache();
    const store = cacheStore(cache as unknown as Cache, "https://p.test");
    const bytes = toBytes("export default 1");
    const hash = await contentHash(bytes);
    await store.put(hash, bytes);
    expect([...cache.entries.keys()]).toEqual([`https://p.test/.content/${hash}`]);
    expect(await store.get(hash)).toEqual(bytes);
    await store.delete(hash);
    expect(await store.get(hash)).toBeUndefined();
  });
});
