import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * A doc made in a tab is kept in IndexedDB, so after a reload empties the
 * tab's Repo it's still there, with no network involved.
 */
test("a doc survives a page reload via IndexedDB", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await waitForServiceWorkerActive(page);
  await waitForRepoReady(page);

  const url = await createDoc(page, { note: "persist-me" });

  // Confirm the doc has left `page`'s memory before reloading. Asking `page`
  // proves nothing (its own Repo answers from memory), so ask a tab that never
  // had it: otherwise the reload can come mid-save and the doc is lost.
  const probe = await context.newPage();
  await probe.goto("/");
  await waitForRepoReady(probe);
  await expect
    .poll(async () => findDocField<string>(probe, url, "note"), {
      timeout: 15_000,
    })
    .toBe("persist-me");
  await probe.close();

  await page.reload();
  await waitForRepoReady(page);

  const value = await findDocField<string>(page, url, "note");
  expect(value).toBe("persist-me");
});
