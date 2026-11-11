import { test, type BrowserContext, type Page } from "@playwright/test";
import {
  MODES,
  createDoc,
  flush,
  getField,
  openTab,
  awaitOnline,
  record,
  setField,
} from "./bench.js";

const EDITS = 20;

// The second-writer question, with nothing but storage to answer it: the sync
// server is cut off before any doc exists, so it never has one, and the tab
// that wrote is closed before the tab that reads opens, so a live sibling can't
// answer either. "Storage" is the automerge worker's IndexedDB. (Playwright's
// routeWebSocket can't reach the worker's socket, so the worker is told.)
async function openOffline(context: BrowserContext): Promise<Page> {
  const page = await openTab(context);
  await page.evaluate(() => window.bench.setOffline(true));
  if (!(await awaitOnline(page, false))) {
    throw new Error("the worker's link to the server didn't go down");
  }
  return page;
}

for (const mode of MODES) {
  test(`${mode}: a doc written by a closed tab is found by the next`, async ({
    context,
  }) => {
    const a = await openOffline(context);
    const url = await createDoc(a, { n: 0 });
    for (let i = 1; i <= EDITS; i++) await setField(a, url, "n", i);
    await flush(a);
    await a.close();

    const b = await openOffline(context);
    const started = Date.now();
    const seen = await getField<number>(b, url, "n").catch(() => undefined);
    const found = seen !== undefined;
    record({
      metric: "a fresh tab finds a closed tab's doc (no server)",
      mode,
      value: found,
      unit: "ok",
    });
    record({
      metric: "…time to find it, from storage",
      mode,
      value: found ? Date.now() - started : null,
      unit: "ms",
    });
    record({
      metric: "…and every edit made before the close is in it",
      mode,
      value: seen === EDITS,
      unit: "ok",
    });
  });

  // Both tabs close right after their last edit, as a user would. This asks
  // whether edits still in flight when the tab goes away make it: the tab
  // flushes, which hands them to the automerge worker to write.
  test(`${mode}: two tabs write the same doc and close; a third reads it`, async ({
    context,
  }) => {
    const a = await openOffline(context);
    const b = await openOffline(context);
    const url = await createDoc(a, { a: 0, b: 0 });
    await flush(a);
    await getField(b, url, "a");

    for (let i = 1; i <= EDITS; i++) {
      await Promise.all([
        setField(a, url, "a", i),
        setField(b, url, "b", i),
      ]);
    }
    await Promise.all([flush(a), flush(b)]);
    await a.close();
    await b.close();

    // Read once, then again after a pause: the first says whether the doc is
    // complete on arrival, the second whether the rest was merely late or is
    // gone with the tabs that made it.
    const c = await openOffline(context);
    const read = () =>
      Promise.all([
        getField<number>(c, url, "a").catch(() => undefined),
        getField<number>(c, url, "b").catch(() => undefined),
      ]);
    const first = await read();
    await c.waitForTimeout(5_000);
    const [fromA, fromB] = await read();
    record({
      metric: "edits from tabs closed right after editing all survive",
      mode,
      value: first[0] === EDITS && first[1] === EDITS,
      unit: "ok",
    });
    record({
      metric: "…or at least 5s later",
      mode,
      value: fromA === EDITS && fromB === EDITS,
      unit: "ok",
    });
  });
}
