import { test } from "@playwright/test";
import { MODES, marks, online, openTab, record, rendererMemory } from "./bench.js";

// Cold boot: navigation start to `window.repo`, then to the server link being
// up (performance.now() is relative to navigation start, so the marks are
// already the numbers wanted). Memory is read once every tab is up.
// The first tab pays everything; later tabs show what a warm origin saves.
for (const mode of MODES) {
  for (const tabs of [1, 3, 10]) {
    test(`${mode}: boot ${tabs} tab(s)`, async ({ browser, context }) => {
      const pages = [];
      for (let i = 0; i < tabs; i++) pages.push(await openTab(context, mode));

      const first = await marks(pages[0]);
      record({
        metric: "boot → repo, first tab",
        mode,
        tabs,
        value: first.ready,
        unit: "ms",
      });
      if (tabs > 1) {
        const last = await marks(pages[tabs - 1]);
        record({
          metric: "boot → repo, last tab",
          mode,
          tabs,
          value: last.ready,
          unit: "ms",
        });
      }
      record({
        metric: "boot → server connected, first tab",
        mode,
        tabs,
        value: await online(pages[0]),
        unit: "ms",
      });

      await Promise.all(pages.map((page) => online(page)));
      // Let storage flushes and the first sync rounds settle first.
      await pages[0].waitForTimeout(2_000);
      const memory = await rendererMemory(browser);
      record({
        metric: "renderer memory, all tabs + workers",
        mode,
        tabs,
        value: memory.mb,
        unit: "MB",
      });
      record({
        metric: "renderer processes",
        mode,
        tabs,
        value: memory.processes,
        unit: "n",
      });
    });
  }
}
