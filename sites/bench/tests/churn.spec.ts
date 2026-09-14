import { expect, test } from "@playwright/test";
import {
  MODES,
  awaitField,
  createDoc,
  online,
  openTab,
  record,
  serverConfirmed,
  setField,
} from "./bench.js";

// Close the tab that booted everything and check the survivors still sync.
// For shared mode that tab spawned the workers; for per-tab modes it owned a
// storage worker mid-write.
for (const mode of MODES) {
  test(`${mode}: closing the first tab doesn't strand the rest`, async ({
    context,
  }) => {
    const first = await openTab(context, mode);
    const b = await openTab(context, mode);
    const c = await openTab(context, mode);
    await Promise.all([online(first), online(b), online(c)]);
    const url = await createDoc(first, { n: 0 });
    await awaitField(b, url, "n", 0);
    await awaitField(c, url, "n", 0);

    await first.close();

    const started = Date.now();
    const ok = await Promise.all([
      awaitField(c, url, "n", 1).then(() => true, () => false),
      setField(b, url, "n", 1).then(() => serverConfirmed(b, url)).then(() => true, () => false),
    ]).then((results) => results.every(Boolean));
    record({
      metric: "sync still works after the first tab closes",
      mode,
      value: ok,
      unit: "ok",
    });
    if (ok) {
      record({
        metric: "edit → seen + confirmed, after first tab closed",
        mode,
        value: Date.now() - started,
        unit: "ms",
      });
    }
    expect(ok).toBe(true);
  });
}
