import { test } from "@playwright/test";
import { createDoc, flush, getField, openTab, setField, timeFind, online } from "./bench.js";

for (const mode of ["shared-worker", "tab-worker"] as const) {
  test(`${mode}: debug push`, async ({ context }) => {
    const a = await openTab(context, mode, { server: "none" });
    const b = await openTab(context, mode, { server: "none" });
    await Promise.all([online(a), online(b)]);
    a.on("console", (m) => console.log("[a]", m.text()));
    b.on("console", (m) => console.log("[b]", m.text()));
    const url = await createDoc(a, { n: 0 });
    // B asks right away, with the helper's 30s retry cut to 3s.
    const first = await b.evaluate(async (url) => {
      const started = performance.now();
      try {
        const { attempts } = await window.bench.find(url, 3_000);
        return { ok: true, attempts, ms: performance.now() - started };
      } catch (e) {
        return { ok: false, error: String(e), ms: performance.now() - started };
      }
    }, url);
    console.log("B find right after create:", JSON.stringify(first));
    await a.waitForTimeout(2_000);
    // Same (cached) handle, later.
    const second = await b.evaluate(async (url) => {
      try {
        const { attempts } = await window.bench.find(url, 3_000);
        return { ok: true, attempts };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, url);
    console.log("B find 2s later:", JSON.stringify(second));
    // A fresh tab now.
    const c = await openTab(context, mode, { server: "none" });
    const fresh = await timeFind(c, url).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: String(e) }));
    console.log("C (fresh tab) find:", JSON.stringify(fresh));
    // Now edits without flush, then with flush: does a fresh tab see them?
    for (let i = 1; i <= 5; i++) await setField(a, url, "n", i);
    await a.waitForTimeout(1_000);
    const d = await openTab(context, mode, { server: "none" });
    console.log("D sees n after 5 edits + 1s:", await getField(d, url, "n").catch((e) => String(e)));
    for (let i = 6; i <= 10; i++) await setField(a, url, "n", i);
    await flush(a);
    const e = await openTab(context, mode, { server: "none" });
    console.log("E sees n after 5 more edits + flush:", await getField(e, url, "n").catch((e) => String(e)));
    console.log("worker errors A:", JSON.stringify(await a.evaluate(() => window.bench.workerErrors())));
  });
}
