import { expect, test } from "@playwright/test";

/**
 * `&path=` in the hash: a live path rooted at the account. A hash with only a
 * path opens what it names, and the router writes the document's url beside
 * it as `doc=`.
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

test("a hash with only path= opens what it names", async ({ page, browserName }) => {
  test.skip(
    browserName !== "chromium",
    "needs the full-UI boot for an account, which is only reliable on chromium (see install-tool.spec.ts)"
  );
  test.setTimeout(300_000);

  await page.goto("/", { timeout: 120_000 });
  await page.waitForFunction(() => !!window.patchwork?.account, null, {
    timeout: 180_000,
  });

  const { url, path } = await page.evaluate(async () => {
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
    const account = window.patchwork!.account;
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account.documentId))
    );
    const acctHash = base58(digest.slice(0, 12));

    const file = window.repo.create<Record<string, unknown>>();
    file.change((d) => {
      d["@patchwork"] = { type: "file" };
      d.content = "opened by path";
      d.mimeType = "text/plain";
    });
    const root = await window.repo.find<{ docs: unknown[] }>(account.doc().rootFolderUrl!);
    root.change((d) => {
      d.docs.push({ name: "path test", type: "file", url: file.url });
    });
    return { url: file.url, path: `${acctHash}/${encodeURIComponent("path test")}` };
  });

  await page.evaluate((path) => (location.hash = `path=${path}`), path);
  await expect
    .poll(() => page.evaluate(() => location.hash), { timeout: 60_000 })
    .toContain(`doc=${url}`);
  expect(await page.evaluate(() => location.hash)).toContain(`path=${path}`);
});
