import { expect, test } from "@playwright/test";
import {
  MODES,
  createDoc,
  getField,
  openTab,
  record,
  setField,
  type Mode,
} from "./bench.js";

const EDITS = 20;

// The second-writer question. Per-tab modes run with no server, so a tab can
// only see another's work through the IndexedDB they both write. Shared mode
// keeps its socket (the worker's server is build-time) but tabs there only
// meet through the worker, so the server doesn't help it either.
const server = (mode: Mode) => (mode === "shared" ? undefined : "none");

async function flush(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.repo.flush());
}

for (const mode of MODES) {
  test(`${mode}: a doc written by one tab is found by the next`, async ({
    context,
  }) => {
    const a = await openTab(context, mode, { server: server(mode) });
    const url = await createDoc(a, { n: 0 });
    for (let i = 1; i <= EDITS; i++) await setField(a, url, "n", i);
    await flush(a);

    const b = await openTab(context, mode, { server: server(mode) });
    const started = Date.now();
    const seen = await getField<number>(b, url, "n").catch(() => undefined);
    record({
      metric: "second tab finds first tab's doc (no server)",
      mode,
      value: seen === EDITS,
      unit: "ok",
    });
    if (seen === EDITS) {
      record({
        metric: "second tab find, from storage",
        mode,
        value: Date.now() - started,
        unit: "ms",
      });
    }
    expect(seen).toBe(EDITS);
  });

  // Both tabs close right after their last edit, as a user would. With tabs
  // alive the worker ends up with everything (checked separately); this asks
  // whether edits still in flight when the tab goes away make it.
  test(`${mode}: two tabs write the same doc and close; a third reads it`, async ({
    context,
  }) => {
    const a = await openTab(context, mode, { server: server(mode) });
    const b = await openTab(context, mode, { server: server(mode) });
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
    const c = await openTab(context, mode, { server: server(mode) });
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
    expect({ fromA, fromB }).toEqual({ fromA: EDITS, fromB: EDITS });
  });
}
