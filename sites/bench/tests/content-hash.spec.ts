// What the service worker pays on every hit of the content store: it hashes
// what it read before serving it, since anything on the origin can write
// CacheStorage. SHA-256 over typical module sizes, in the page, which runs the
// same crypto.subtle the service worker does.
import { test } from "@playwright/test";
import { median, openTab, record } from "./bench.js";

const SIZES = [
  ["10KB", 10 * 1024],
  ["100KB", 100 * 1024],
  ["1MB", 1024 * 1024],
] as const;
const RUNS = 200;

test("patchwork: sha-256 of a content store hit", async ({ context }) => {
  const page = await openTab(context, "patchwork", { server: "none" });
  for (const [label, bytes] of SIZES) {
    const times = await page.evaluate(
      async ({ bytes, runs }) => {
        const data = new Uint8Array(bytes).map((_, i) => i % 251);
        const times: number[] = [];
        for (let i = 0; i < runs; i++) {
          const start = performance.now();
          await crypto.subtle.digest("SHA-256", data);
          times.push(performance.now() - start);
        }
        return times;
      },
      { bytes, runs: RUNS }
    );
    record({
      metric: `sha-256 of a ${label} hit`,
      mode: "patchwork",
      value: median(times),
      unit: "ms",
    });
  }
});
