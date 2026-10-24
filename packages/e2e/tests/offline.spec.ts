import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  setDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * Local-first behaviour with the network cut.
 *
 * Everything in B1 scope routes through the SW relay + IndexedDB, so none
 * of it should need the network once the page has booted. These tests boot
 * online, then flip the context offline and assert that doc creation,
 * multi-tab sync, and (via the SW page/asset cache) even a full reload
 * keep working.
 */

test("docs sync between tabs while offline", async ({ context }) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForRepoReady(tabB);

  await context.setOffline(true);

  const url = await createDoc(tabA, { status: "made-offline" });
  expect(url).toMatch(/^automerge:/);

  await expect
    .poll(async () => findDocField<string>(tabB, url, "status"), {
      timeout: 30_000,
    })
    .toBe("made-offline");

  await setDocField(tabB, url, "status", "edited-offline");

  await expect
    .poll(async () => findDocField<string>(tabA, url, "status"), {
      timeout: 30_000,
    })
    .toBe("edited-offline");
});

test("the app boots from the SW cache while offline and keeps its docs", async ({
  page,
  context,
  browserName,
}) => {
  // WebKit's offline emulation makes reload throw an internal error before
  // the SW gets a chance to serve from cache.
  test.skip(browserName === "webkit", "flaky offline emulation in webkit");

  await page.goto("/");
  await waitForServiceWorkerActive(page);
  await waitForRepoReady(page);

  // First load may have fetched some assets before the SW controlled the
  // page. A second online load routes everything through the SW so its
  // background cache holds the full app shell.
  await page.reload();
  await waitForRepoReady(page);

  const url = await createDoc(page, { note: "offline-survivor" });
  await expect
    .poll(async () => findDocField<string>(page, url, "note"), {
      timeout: 15_000,
    })
    .toBe("offline-survivor");

  // The SW caches in the background of each fetch; under load that can lag
  // the page, so before cutting the network wait for the entries only the
  // SW cache can serve offline (the page itself and the wasm; the hashed
  // /assets chunks survive via the browser's own HTTP cache).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          // The wasm is under hashed names; the page preloads it by them.
          const urls = [
            location.href,
            ...[
              ...document.querySelectorAll<HTMLLinkElement>(
                'link[rel="preload"][as="fetch"]',
              ),
            ].map((link) => link.href),
          ];
          const matches = await Promise.all(urls.map((u) => caches.match(u)));
          return matches.filter((m) => !m).length;
        }),
      { timeout: 30_000 },
    )
    .toBe(0);

  await context.setOffline(true);
  await page.reload();
  await waitForRepoReady(page);

  const value = await findDocField<string>(page, url, "note");
  expect(value).toBe("offline-survivor");
});
