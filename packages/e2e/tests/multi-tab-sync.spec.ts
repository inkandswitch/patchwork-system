import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * Sync between two tabs of one browser, with no sync server involved: the
 * most reproducible slice of "sync instantly".
 */
test("a doc created in tab A is found in tab B via the SW relay", async ({
  context,
}) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForServiceWorkerActive(tabB);
  await waitForRepoReady(tabB);

  const url = await createDoc(tabA, { greeting: "hello-from-A" });
  expect(url).toMatch(/^automerge:/);

  const value = await findDocField<string>(tabB, url, "greeting");
  expect(value).toBe("hello-from-A");
});

test("an edit in tab A propagates to an already-open doc in tab B", async ({
  context,
}) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForRepoReady(tabB);

  const url = await createDoc(tabA, { count: 1 });

  expect(await findDocField<number>(tabB, url, "count")).toBe(1);

  await tabA.evaluate(async (u) => {
    const handle = await window.repo.find<{ count: number }>(u);
    handle.change((d) => {
      d.count = 42;
    });
  }, url);

  await expect
    .poll(async () => findDocField<number>(tabB, url, "count"), {
      timeout: 15_000,
    })
    .toBe(42);
});
