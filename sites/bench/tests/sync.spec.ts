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
  timeFind,
} from "./bench.js";

const TABS = 3;
const EDITS = 10;

// Tab A creates and edits; tabs B.. find and watch. Each latency is a median
// over EDITS rounds.
for (const mode of MODES) {
  test(`${mode}: cross-tab and server latency`, async ({ context }) => {
    const pages = [];
    for (let i = 0; i < TABS; i++) pages.push(await openTab(context, mode));
    await Promise.all(pages.map((page) => online(page)));
    const [a, ...others] = pages;

    const url = await createDoc(a, { counter: 0 });
    // Per-tab modes with no local fan-out only learn of the doc via the
    // server, so the first find includes a server round trip by design.
    const finds = await Promise.all(others.map((page) => timeFind(page, url)));
    record({
      metric: "find a doc another tab just created",
      mode,
      value: median(finds.map((find) => find.ms)),
      unit: "ms",
    });
    record({
      metric: "…and the first find() didn't settle unavailable",
      mode,
      value: finds.every((find) => find.attempts === 1),
      unit: "ok",
    });

    const propagation: number[] = [];
    const confirmation: number[] = [];
    for (let i = 1; i <= EDITS; i++) {
      const seen = others.map((page) => awaitField(page, url, "counter", i));
      const edited = await setField(a, url, "counter", i);
      const [arrived, confirmed] = await Promise.all([
        Promise.all(seen),
        serverConfirmed(a, url),
      ]);
      propagation.push(Math.max(...arrived) - edited);
      confirmation.push(confirmed - edited);
    }
    record({
      metric: `edit → seen in ${TABS - 1} other tabs`,
      mode,
      value: median(propagation),
      unit: "ms",
    });
    record({
      metric: "edit → server holds our heads",
      mode,
      value: median(confirmation),
      unit: "ms",
    });
  });
}
