// Boot to a document in hand, for the first tab on the origin and the tenth:
// a doc that only the server has, opened in tab after tab of one context.
import { test } from "@playwright/test";
import {
  MODES,
  createDoc,
  online,
  openTab,
  probeServerPeer,
  record,
  serverConfirmed,
  type Mode,
} from "./bench.js";

const TABS = 10;

for (const mode of MODES) {
  test(`${mode}: boot to an open doc, tab 1 to ${TABS}`, async ({ browser, context }) => {
    test.setTimeout(300_000);
    await probeServerPeer(browser);
    // Somewhere else puts the doc on the server.
    const seeder = await browser.newContext();
    const seed = await openTab(seeder, "pertab");
    await online(seed);
    const url = await createDoc(seed, { title: "open", text: "x".repeat(10_000) });
    await serverConfirmed(seed, url, 30_000);
    await seeder.close();

    const docMs: Array<number | null> = [];
    for (let i = 0; i < TABS; i++) {
      const page = await openTab(context, mode, { open: url });
      const marks = await page
        .waitForFunction(() => window.bench.marks.doc !== undefined && window.bench.marks, null, {
          timeout: 30_000,
        })
        .then((handle) => handle.jsonValue() as Promise<Record<string, number>>)
        .catch(() => null);
      docMs.push(marks ? marks.doc : null);
    }
    const metric = (tab: number) => ({
      metric: `boot → doc open, tab ${tab}`,
      mode: mode as Mode,
      value: docMs[tab - 1],
      unit: "ms" as const,
    });
    record(metric(1));
    record(metric(2));
    record(metric(TABS));
    console.log(`OPEN ${mode} ${JSON.stringify(docMs.map((ms) => ms && Math.round(ms)))}`);
  });
}
