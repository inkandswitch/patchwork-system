import { test } from "@playwright/test";
import {
  MODES,
  awaitField,
  createDoc,
  median,
  online,
  openTab,
  record,
  serverConfirmed,
  setField,
  strangerSees,
  timeFind,
} from "./bench.js";

const TABS = 3;
const EDITS = 10;
const RACE_TIMEOUT_MS = 5_000;
const EDIT_TIMEOUT_MS = 5_000;

// Tab A creates and edits; tabs B.. find and watch. Each latency is a median
// over EDITS rounds.
for (const mode of MODES) {
  test(`${mode}: cross-tab and server latency`, async ({ browser, context }) => {
    const pages = [];
    for (let i = 0; i < TABS; i++) pages.push(await openTab(context, mode));
    await Promise.all(pages.map((page) => online(page)));
    const [a, ...others] = pages;

    const url = await createDoc(a, { counter: 0 });
    // The race: the siblings ask for a doc that may not have left A yet. A
    // find that settles unavailable is retried with a real re-sync (see
    // `find` in src/main.ts); a tab whose find still failed is replaced below.
    const finds = await Promise.all(
      others.map((page) =>
        timeFind(page, url, RACE_TIMEOUT_MS).then(
          (found) => ({ ok: true as const, ...found }),
          () => ({ ok: false as const })
        )
      )
    );
    const found = finds.filter((find) => find.ok);
    record({
      metric: "find a doc another tab just created",
      mode,
      value: found.length ? median(found.map((find) => find.ms)) : null,
      unit: "ms",
    });
    record({
      metric: "…and every such find() succeeded within 5s",
      mode,
      value: finds.every((find) => find.ok),
      unit: "ok",
    });
    record({
      metric: "…and none settled unavailable first",
      mode,
      value: finds.every((find) => find.ok && find.attempts === 1),
      unit: "ok",
    });

    await serverConfirmed(a, url);
    const watchers = [];
    for (const [i, find] of finds.entries()) {
      if (find.ok) {
        watchers.push(others[i]);
        continue;
      }
      await others[i].close();
      const fresh = await openTab(context, mode);
      await online(fresh);
      const { ms } = await timeFind(fresh, url);
      record({
        metric: "find that doc from a fresh tab, once the server has it",
        mode,
        value: ms,
        unit: "ms",
      });
      watchers.push(fresh);
    }

    // Each edit waits a bounded time for the watchers and the server; an edit
    // that doesn't arrive is counted rather than aborting the run, so a mode
    // that strands a tab still gets a row.
    const propagation: number[] = [];
    const confirmation: number[] = [];
    let missed = 0;
    let unconfirmed = 0;
    for (let i = 1; i <= EDITS; i++) {
      const seen = watchers.map((page) =>
        awaitField(page, url, "counter", i, EDIT_TIMEOUT_MS).catch(
          () => undefined
        )
      );
      const edited = await setField(a, url, "counter", i);
      const [arrived, confirmed] = await Promise.all([
        Promise.all(seen),
        serverConfirmed(a, url, EDIT_TIMEOUT_MS).catch(() => undefined),
      ]);
      if (arrived.every((at) => at !== undefined)) {
        propagation.push(Math.max(...(arrived as number[])) - edited);
      } else {
        missed++;
      }
      if (confirmed !== undefined) confirmation.push(confirmed - edited);
      else unconfirmed++;
    }
    if (propagation.length) {
      record({
        metric: `edit → seen in ${TABS - 1} other tabs`,
        mode,
        value: median(propagation),
        unit: "ms",
      });
    }
    record({
      metric: `…every edit reached every other tab within ${EDIT_TIMEOUT_MS / 1000}s`,
      mode,
      value: missed === 0,
      unit: "ok",
    });
    if (confirmation.length) {
      record({
        metric: "edit → server holds our heads",
        mode,
        value: median(confirmation),
        unit: "ms",
      });
    }
    record({
      metric: `…the server confirmed every edit within ${EDIT_TIMEOUT_MS / 1000}s`,
      mode,
      value: unconfirmed === 0,
      unit: "ok",
    });
    // The server's word, checked: a client that shares nothing with these
    // tabs asks the server for the doc.
    const stranger = await strangerSees(browser, url);
    record({
      metric: "…and a stranger gets the whole doc from the server",
      mode,
      value: stranger?.counter === EDITS,
      unit: "ok",
    });
  });
}
