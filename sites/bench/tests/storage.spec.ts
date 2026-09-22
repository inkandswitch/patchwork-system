import { test } from "@playwright/test";
import {
  MODES,
  createDoc,
  flush,
  getField,
  openTab,
  refuseWebSockets,
  record,
  setField,
  type Mode,
} from "./bench.js";

const EDITS = 20;

// The second-writer question, with nothing but storage to answer it: no
// server, and the tab that wrote is closed before the tab that reads opens,
// so a live sibling channel can't answer either. The bare modes take
// `?server=none`; patchwork's server is build-time, so its sockets are
// refused instead. In the worker modes "storage" is the worker's IndexedDB;
// the shared worker also keeps what it relayed in memory.
const server = (mode: Mode) => (mode === "patchwork" ? undefined : "none");

async function storageOnly(context: import("@playwright/test").BrowserContext, mode: Mode) {
  if (mode === "patchwork") await refuseWebSockets(context);
}

for (const mode of MODES) {
  test(`${mode}: a doc written by a closed tab is found by the next`, async ({
    context,
  }) => {
    await storageOnly(context, mode);
    const a = await openTab(context, mode, { server: server(mode) });
    const url = await createDoc(a, { n: 0 });
    for (let i = 1; i <= EDITS; i++) await setField(a, url, "n", i);
    await flush(a);
    await a.close();

    const b = await openTab(context, mode, { server: server(mode) });
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
  // whether edits still in flight when the tab goes away make it: a tab with
  // its own storage flushes to disk, a storageless tab can only have handed
  // them to its worker.
  test(`${mode}: two tabs write the same doc and close; a third reads it`, async ({
    context,
  }) => {
    await storageOnly(context, mode);
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
  });
}
