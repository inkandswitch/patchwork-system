import { expect, test } from "@playwright/test";
import { waitForRepoReady } from "./helpers.js";

/**
 * The service worker's content store for pinned `/@/` URLs. Anything on the
 * origin can write CacheStorage, so the store is untrusted: every read is
 * hashed and checked against the file list the pinned URL names by hash.
 * This plays the page that tries to get around that.
 */

declare global {
  interface Window {
    patchwork?: {
      account: {
        documentId: string;
        doc(): { rootFolderUrl?: string };
      };
    };
  }
}

test("a forged store entry is never served", async ({ page, browserName }) => {
  test.skip(
    browserName !== "chromium",
    "needs the full-UI boot for an account, which is only reliable on chromium (see install-tool.spec.ts)"
  );
  test.setTimeout(300_000);

  await page.goto("/", { timeout: 120_000 });
  await page.waitForFunction(() => !!window.patchwork?.account, null, {
    timeout: 180_000,
  });

  const { pinned, acctHash, sha256 } = await page.evaluate(async () => {
    const encoder = new TextEncoder();
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const base58 = (bytes: Uint8Array) => {
      let n = 0n;
      for (const byte of bytes) n = n * 256n + BigInt(byte);
      let out = "";
      while (n > 0n) {
        out = ALPHABET[Number(n % 58n)] + out;
        n /= 58n;
      }
      for (const byte of bytes) {
        if (byte !== 0) break;
        out = "1" + out;
      }
      return out;
    };
    const sha = async (text: string) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

    const account = window.patchwork!.account;
    const acctHash = base58((await sha(account.documentId)).slice(0, 12));

    const file = window.repo.create<Record<string, unknown>>();
    file.change((d) => {
      d.content = "export default 42";
      d.mimeType = "text/javascript";
    });
    const root = await window.repo.find<{ docs: unknown[] }>(
      account.doc().rootFolderUrl!
    );
    root.change((d) => {
      d.docs.push({ name: "forge-test.js", type: "file", url: file.url });
    });

    // The live URL redirects to the pinned one; fetch follows it.
    let pinned = "";
    for (let i = 0; i < 30 && !pinned; i++) {
      const response = await fetch(`/@/${acctHash}/forge-test.js`);
      if (response.ok && response.redirected) pinned = response.url;
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const digest = await sha("export default 42");
    const sha256 = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { pinned, acctHash, sha256 };
  });
  expect(pinned).toContain("/@/");

  await page.evaluate(
    async ({ acctHash, sha256 }) => {
      const cache = await caches.open(`patchwork-content-${acctHash}`);
      await cache.put(`/.content/${sha256}`, new Response("export default 666"));
    },
    { acctHash, sha256 }
  );

  await page.reload({ timeout: 120_000 });
  await waitForRepoReady(page, 180_000);
  const value = await page.evaluate(
    async (url) => (await import(/* @vite-ignore */ url)).default,
    pinned
  );
  expect(value).toBe(42);
});
