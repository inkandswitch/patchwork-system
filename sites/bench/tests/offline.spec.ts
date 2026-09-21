import { expect, test } from "@playwright/test";
import {
  MODES,
  awaitField,
  awaitOnline,
  createDoc,
  getField,
  online,
  openTab,
  record,
  serverConfirmed,
  setField,
  setOffline,
} from "./bench.js";

// Both tabs edit while the network is cut, then it comes back. The cut is
// Playwright's offline emulation for a tab's own socket, and a control
// message for a worker's (see setOffline); whether the link was actually seen
// down is recorded, so a mode whose socket survived the cut says so.
for (const mode of MODES) {
  test(`${mode}: concurrent offline edits converge on reconnect`, async ({
    context,
  }) => {
    const a = await openTab(context, mode);
    const b = await openTab(context, mode);
    await Promise.all([online(a), online(b)]);
    const url = await createDoc(a, { x: 0, y: 0 });
    await awaitField(b, url, "x", 0);
    await serverConfirmed(a, url);

    await setOffline(context, [a, b], true);
    const wentDown = (await Promise.all([
      awaitOnline(a, false),
      awaitOnline(b, false),
    ])).every(Boolean);
    record({
      metric: "server link seen down while offline",
      mode,
      value: wentDown,
      unit: "ok",
    });
    await setField(a, url, "x", 1);
    await setField(b, url, "y", 1);
    await a.waitForTimeout(2_000);
    await setOffline(context, [a, b], false);

    const reconnected = Date.now();
    const [seenY, seenX] = await Promise.all([
      awaitField(a, url, "y", 1, 60_000).then(() => true, () => false),
      awaitField(b, url, "x", 1, 60_000).then(() => true, () => false),
    ]);
    const converged = Date.now() - reconnected;
    const confirmed = await serverConfirmed(a, url).then(() => true, () => false);

    record({
      metric: "offline edits in two tabs both survive reconnect",
      mode,
      value: seenY && seenX && confirmed,
      unit: "ok",
    });
    if (seenY && seenX) {
      record({ metric: "reconnect → tabs converged", mode, value: converged, unit: "ms" });
    }

    const c = await openTab(context, mode);
    const [x, y] = await Promise.all([
      getField<number>(c, url, "x"),
      getField<number>(c, url, "y"),
    ]);
    expect({ seenY, seenX, confirmed, x, y }).toEqual({
      seenY: true,
      seenX: true,
      confirmed: true,
      x: 1,
      y: 1,
    });
  });
}
