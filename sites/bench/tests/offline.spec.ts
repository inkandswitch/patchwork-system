import { test } from "@playwright/test";
import {
  MODES,
  WORKER_MODES,
  awaitField,
  awaitOnline,
  createDoc,
  getField,
  isOnline,
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
//
// The first two rows check the bench, not Patchwork: that the cut held for the
// whole offline stretch. Where it didn't (a browser whose offline emulation
// lets a reconnect through, a socket out of the switch's reach) the tabs were
// never offline, so the rows after them record nothing rather than pass.
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
    await setField(a, url, "x", 1);
    await setField(b, url, "y", 1);
    await a.waitForTimeout(2_000);

    // Down at the start and still down now, with nothing sent through.
    const stillDown = !(await Promise.all([isOnline(a), isOnline(b)])).some(
      Boolean
    );
    const stayedDown = wentDown && stillDown && network.leaked() === 0;
    // A stranger that can't get the doc at all proves nothing either way.
    const stranger = await strangerSees(browser, url);
    const unseen =
      stranger !== undefined && stranger.x !== 1 && stranger.y !== 1;
    const held = stayedDown && unseen;
    const why = [
      !wentDown && "the link never went down",
      wentDown && !stillDown && "a tab was back online before the end",
      network.leaked() && `${network.leaked()} messages reached the server`,
      stranger === undefined && "the stranger couldn't get the doc",
      stranger && !unseen && "the server had the offline edits",
    ]
      .filter(Boolean)
      .join("; ");
    // In the worker modes the bench closes the socket itself, so this only
    // says something about the tab modes' proxy.
    if (!WORKER_MODES.includes(mode)) {
      record({
        metric: "server link seen down while offline",
        mode,
        value: stayedDown,
        unit: "ok",
        harness: true,
        note: stayedDown ? undefined : why,
      });
    }
    record({
      metric: "…and the server did not see the offline edits",
      mode,
      value: unseen,
      unit: "ok",
      harness: true,
      note: unseen ? undefined : why,
    });
    if (!held) {
      const note = `offline switch didn't hold (${why}), so the offline rows record nothing`;
      console.warn(`[${mode}] ${note}`);
      test.info().annotations.push({ type: "warning", description: note });
    }

    const [ay, bx] = await Promise.all([
      getField<number>(a, url, "y"),
      getField<number>(b, url, "x"),
    ]);
    const local = ay === 1 && bx === 1;
    record({
      metric: "tabs converged while offline, over a local channel",
      mode,
      value: held ? local : null,
      unit: "ok",
      note: local ? undefined : `tab A saw y ${ay}, tab B saw x ${bx}`,
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
      value: held ? seenY && seenX && confirmed : null,
      unit: "ok",
      note:
        [
          !seenY && "tab A never got B's edit",
          !seenX && "tab B never got A's edit",
          !confirmed && "the server never confirmed A's heads",
        ]
          .filter(Boolean)
          .join("; ") || undefined,
    });
    record({
      metric: "reconnect → tabs converged (only where they hadn't already)",
      mode,
      value: held && !local && seenY && seenX ? converged : null,
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
      value: held ? x === 1 && y === 1 : null,
      unit: "ok",
      note: x === 1 && y === 1 ? undefined : `the fresh tab saw x ${x}, y ${y}`,
    });
  });
}
