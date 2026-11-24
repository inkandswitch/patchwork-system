import { test } from "@playwright/test";
import {
  MODES,
  awaitField,
  createDoc,
  online,
  openTab,
  record,
  said,
  serverConfirmed,
  setField,
} from "./bench.js";

// Close the tab that booted everything and check the survivors still sync.
// In patchwork mode that tab spawned the automerge worker; in tab-worker mode
// its subduction node dies with it; in shared-worker mode the node it spawned
// outlives it.
for (const mode of MODES) {
  test(`${mode}: closing the first tab doesn't strand the rest`, async ({
    context,
  }) => {
    const first = await openTab(context, mode);
    const b = await openTab(context, mode);
    const c = await openTab(context, mode);
    await Promise.all([online(first), online(b), online(c)]);
    const url = await createDoc(first, { n: 0 });
    await serverConfirmed(first, url);
    await awaitField(b, url, "n", 0);
    await awaitField(c, url, "n", 0);

    await first.close();

    const started = Date.now();
    const failures = (
      await Promise.all([
        awaitField(c, url, "n", 1).then(
          () => undefined,
          (error) => `tab c: ${said(error)}`
        ),
        setField(b, url, "n", 1)
          .then(() => serverConfirmed(b, url))
          .then(
            () => undefined,
            (error) => `tab b: ${said(error)}`
          ),
      ])
    ).filter((failure) => failure !== undefined);
    const ok = failures.length === 0;
    record({
      metric: "sync still works after the first tab closes",
      mode,
      value: ok,
      unit: "ok",
      note: ok ? undefined : failures.join("; "),
    });
    if (ok) {
      record({
        metric: "edit → seen + confirmed, after first tab closed",
        mode,
        value: Date.now() - started,
        unit: "ms",
      });
    }
  });
}
