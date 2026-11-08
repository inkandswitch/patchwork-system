import { expect, test } from "@playwright/test";
import { waitForRepoReady, waitForServiceWorkerActive } from "./helpers.js";

/**
 * Cold boot: a fresh visit registers the service worker, initialises wasm and
 * brings up the tab's Repo within a tight budget. It checks `window.repo`, not
 * the UI: rendering the default frame needs the sync server, and the full-UI
 * suites (cross-profile-sync, install-tool) cover that.
 */
test("cold boot brings up the service worker and tab repo", async ({ page }) => {
  await page.goto("/");

  await waitForServiceWorkerActive(page);

  await waitForRepoReady(page);

  const hasRepo = await page.evaluate(
    () => typeof window.repo?.create === "function",
  );
  expect(hasRepo).toBe(true);
});

test("a second load reuses the already-active service worker quickly", async ({
  page,
}) => {
  await page.goto("/");
  await waitForServiceWorkerActive(page);
  await waitForRepoReady(page);

  // A second load meets the already-active service worker: no fresh install.
  const start = Date.now();
  await page.reload();
  await waitForRepoReady(page, 15_000);
  const elapsed = Date.now() - start;

  expect(elapsed).toBeLessThan(15_000);
});
