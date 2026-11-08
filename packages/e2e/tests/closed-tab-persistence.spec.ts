import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * A doc outlives the tab that made it: once it's in IndexedDB, closing that
 * tab loses nothing, and a tab opened later finds the doc with all its
 * structure intact.
 */

test("a doc outlives the tab that created it", async ({ context }) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const url = await createDoc(tabA, {
    title: "orphaned-but-fine",
    meta: { tags: ["one", "two"], nested: { depth: 2 } },
  });

  // Confirm the doc has left tab A's memory before closing it: a find from a
  // second tab proves it.
  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForRepoReady(tabB);
  await expect
    .poll(async () => findDocField<string>(tabB, url, "title"), {
      timeout: 15_000,
    })
    .toBe("orphaned-but-fine");

  await tabA.close();

  const tabC = await context.newPage();
  await tabC.goto("/");
  await waitForRepoReady(tabC);

  const doc = await tabC.evaluate(async (u) => {
    const handle = await window.repo.find<Record<string, unknown>>(u);
    return handle.doc();
  }, url);

  expect(doc).toEqual({
    title: "orphaned-but-fine",
    meta: { tags: ["one", "two"], nested: { depth: 2 } },
  });
});
