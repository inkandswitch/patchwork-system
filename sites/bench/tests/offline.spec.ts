import { test } from "@playwright/test";
import {
  MODES,
  WORKER_MODES,
  awaitField,
  awaitOnline,
  createDoc,
  getField,
  offlineSwitch,
  online,
  openTab,
  record,
  serverConfirmed,
  setField,
  strangerSees,
} from "./bench.js";

// Both tabs edit while the link to the server is cut, then it comes back. The
// cut is a WebSocket proxy closing a tab's own socket, and a control message
// for a worker's (see offlineSwitch). Modes with a local channel converge
// while offline; the reconnect timing is only meaningful where they didn't.
for (const mode of MODES) {
  test(`${mode}: concurrent offline edits converge on reconnect`, async ({
    browser,
    context,
  }) => {
    const network = await offlineSwitch(context);
    const a = await openTab(context, mode);
    const b = await openTab(context, mode);
    await Promise.all([online(a), online(b)]);
    const url = await createDoc(a, { x: 0, y: 0 });
    // Settled at the server before anyone else asks: the racing find is
    // sync.spec's business.
    await serverConfirmed(a, url);
    await awaitField(b, url, "x", 0);

    await network.set([a, b], true);
    const wentDown = (await Promise.all([
      awaitOnline(a, false),
      awaitOnline(b, false),
    ])).every(Boolean);
    // In the worker modes the bench closes the socket itself, so this only
    // says something about the tab modes' proxy.
    if (!WORKER_MODES.includes(mode)) {
      record({
        metric: "server link seen down while offline",
        mode,
        value: wentDown,
        unit: "ok",
      });
    }
    await setField(a, url, "x", 1);
    await setField(b, url, "y", 1);
    await a.waitForTimeout(2_000);

    const leaked = await strangerSees(browser, url);
    record({
      metric: "…and the server did not see the offline edits",
      mode,
      value: leaked?.x !== 1 && leaked?.y !== 1,
      unit: "ok",
    });
    const [ay, bx] = await Promise.all([
      getField<number>(a, url, "y"),
      getField<number>(b, url, "x"),
    ]);
    const local = ay === 1 && bx === 1;
    record({
      metric: "tabs converged while offline, over a local channel",
      mode,
      value: local,
      unit: "ok",
    });

    await network.set([a, b], false);
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
    record({
      metric: "reconnect → tabs converged (only where they hadn't already)",
      mode,
      value: !local && seenY && seenX ? converged : null,
      unit: "ms",
    });

    const c = await openTab(context, mode);
    const [x, y] = await Promise.all([
      getField<number>(c, url, "x").catch(() => undefined),
      getField<number>(c, url, "y").catch(() => undefined),
    ]);
    record({
      metric: "…and a fresh tab sees both",
      mode,
      value: x === 1 && y === 1,
      unit: "ok",
    });
  });
}
