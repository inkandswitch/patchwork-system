import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * Two tabs editing the same doc must converge without losing either edit.
 * The edits are fired with no ordering between the tabs, so they race, and
 * Automerge's merge must keep both.
 */

test("edits to different fields from two tabs both survive the merge", async ({
  context,
}) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForRepoReady(tabB);

  const url = await createDoc(tabA, { a: "", b: "" });
  await expect
    .poll(async () => findDocField<string>(tabB, url, "a"), { timeout: 30_000 })
    .toBe("");

  await Promise.all([
    tabA.evaluate(async (u) => {
      const handle = await window.repo.find<{ a: string }>(u);
      handle.change((d) => {
        d.a = "from-A";
      });
    }, url),
    tabB.evaluate(async (u) => {
      const handle = await window.repo.find<{ b: string }>(u);
      handle.change((d) => {
        d.b = "from-B";
      });
    }, url),
  ]);

  for (const tab of [tabA, tabB]) {
    await expect
      .poll(
        async () => {
          const doc = await tab.evaluate(async (u) => {
            const handle = await window.repo.find<Record<string, string>>(u);
            return handle.doc();
          }, url);
          return [doc.a, doc.b];
        },
        { timeout: 15_000 },
      )
      .toEqual(["from-A", "from-B"]);
  }
});

test("list pushes from two tabs merge without dropping items", async ({
  context,
}) => {
  const tabA = await context.newPage();
  await tabA.goto("/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForRepoReady(tabB);

  const url = await createDoc(tabA, { items: [] });
  await expect
    .poll(
      async () =>
        (await findDocField<unknown[]>(tabB, url, "items")) != null,
      { timeout: 30_000 },
    )
    .toBe(true);

  const push = (tab: typeof tabA, item: string) =>
    tab.evaluate(
      async ([u, i]) => {
        const handle = await window.repo.find<{ items: string[] }>(u);
        handle.change((d) => {
          d.items.push(i);
        });
      },
      [url, item] as const,
    );

  await Promise.all([push(tabA, "apple"), push(tabB, "banana")]);

  for (const tab of [tabA, tabB]) {
    await expect
      .poll(
        async () =>
          [...(await findDocField<string[]>(tab, url, "items"))].sort(),
        { timeout: 15_000 },
      )
      .toEqual(["apple", "banana"]);
  }
});
