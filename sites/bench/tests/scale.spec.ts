import { test, type Page } from "@playwright/test";
import {
  type Mode,
  awaitField,
  createDoc,
  marks,
  median,
  online,
  openTab,
  probeServerPeer,
  record,
  rendererMemory,
  serverConfirmed,
  setField,
  timeFind,
  withStall,
} from "./bench.js";

const MODES = (process.env.SCALE_MODES ?? "star,shared-worker,patchwork")
  .split(",")
  .map((mode) => mode.trim())
  .filter(Boolean) as Mode[];
const TABS = Number(process.env.SCALE_TABS ?? 40);
const ROUNDS = 5;
const FIND_TIMEOUT_MS = 5_000;
const EDIT_TIMEOUT_MS = 5_000;
const LINKED_WAIT_MS = 3_000;
const WATCHERS_SETTLE_MS = 200;

function settled<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, ms)),
  ]);
}

function medianOrNull(values: number[]): number | null {
  return values.length ? median(values) : null;
}

function maxOrNull(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function round(value: number | null, places: number): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

type Counters = {
  rounds: number;
  bytes: number | null;
  writes: number | null;
};

function counters(page: Page): Promise<Counters> {
  return page.evaluate(() => ({
    rounds: window.bench.syncRounds(),
    bytes: window.bench.serverBytes(),
    writes: window.bench.storageWrites(),
  }));
}

function perEditPerTab(
  before: Counters[],
  after: Counters[],
  key: "bytes" | "writes",
  edits: number
): number | null {
  let total = 0;
  for (const [i, b] of before.entries()) {
    const a = after[i][key];
    const v = b[key];
    if (a === null || v === null) return null;
    total += a - v;
  }
  return total / edits / before.length;
}

for (const mode of MODES) {
  test(`${mode}: ${TABS} tabs on one doc`, async ({ browser, context }) => {
    test.setTimeout(Math.max(600_000, TABS * 15_000));
    const N = TABS;
    await probeServerPeer(browser);

    const opening = Date.now();
    const pages: Page[] = [];
    for (let i = 0; i < N; i++) pages.push(await openTab(context, mode));
    const openMs = Date.now() - opening;
    const connected = await Promise.all(pages.map((page) => online(page)));
    const onlineMs = Date.now() - opening;

    const last = pages[N - 1];
    await last
      .waitForFunction(() => window.bench.marks.linked !== undefined, null, {
        timeout: LINKED_WAIT_MS,
      })
      .catch(() => {});
    const boot = await marks(last);
    const sinceStart = (name: string) =>
      boot[name] === undefined ? null : boot[name] - boot.start;

    const [creator, ...others] = pages;
    const url = await createDoc(creator, { title: "scale" });
    const finds = await Promise.all(
      others.map((page) =>
        timeFind(page, url, FIND_TIMEOUT_MS).then(
          (found) => ({ ok: true as const, ...found }),
          () => ({ ok: false as const })
        )
      )
    );
    const found = finds.filter((find) => find.ok);
    const findMs = found.map((find) => find.ms);

    const before = await Promise.all(pages.map(counters));
    const editors = new Set<number>();
    const seenMs: number[] = [];
    const missed = pages.map(() => 0);
    const confirmMs: number[] = [];
    let unconfirmed = 0;
    const { stall } = await withStall(creator, async () => {
      for (let r = 0; r < ROUNDS; r++) {
        const editor = pages[(r * 7) % N];
        editors.add((r * 7) % N);
        const watchers = pages.filter((page) => page !== editor);
        const field = String(r);
        const seen = watchers.map((page) =>
          settled(
            awaitField(page, url, field, r, EDIT_TIMEOUT_MS),
            EDIT_TIMEOUT_MS + 1_000
          )
        );
        await editor.waitForTimeout(WATCHERS_SETTLE_MS);
        const edited = await setField(editor, url, field, r);
        const [arrived, confirmed] = await Promise.all([
          Promise.all(seen),
          settled(
            serverConfirmed(editor, url, EDIT_TIMEOUT_MS),
            EDIT_TIMEOUT_MS + 1_000
          ),
        ]);
        for (const [i, at] of arrived.entries()) {
          if (at === undefined) missed[pages.indexOf(watchers[i])]++;
          else seenMs.push(at - edited);
        }
        if (confirmed === undefined) unconfirmed++;
        else confirmMs.push(confirmed - edited);
      }
    });

    const after = await Promise.all(pages.map(counters));
    const roundsPerSiblingEdit = pages
      .map((_, i) => i)
      .filter((i) => !editors.has(i))
      .map((i) => (after[i].rounds - before[i].rounds) / ROUNDS);

    const memory = await rendererMemory(browser);
    const workerErrors = (
      await Promise.all(
        pages.map((page) => page.evaluate(() => window.bench.workerErrors()))
      )
    ).flat();

    const result = {
      mode,
      tabs: N,
      openMs,
      onlineMs,
      bootRepoMs: sinceStart("repo"),
      bootLinkedMs: sinceStart("linked"),
      bootNodeMs: sinceStart("node"),
      bootReadyMs: boot.ready,
      bootServerMs: connected[N - 1],
      findMedianMs: medianOrNull(findMs),
      findSlowestMs: maxOrNull(findMs),
      found: found.length,
      allFound: found.length === others.length,
      retried: found.filter((find) => find.attempts > 1).length,
      seenMedianMs: medianOrNull(seenMs),
      seenSlowestMs: maxOrNull(seenMs),
      tabsSawEveryEdit: missed.slice(1).filter((n) => n === 0).length,
      allTabsSawEveryEdit: missed.filter((n) => n === 0).length,
      missedPerTab: missed,
      confirmMedianMs: medianOrNull(confirmMs),
      confirmed: confirmMs.length,
      allConfirmed: unconfirmed === 0,
      memoryMb: memory.mb,
      processes: memory.processes,
      stallMaxMs: stall.maxMs,
      stallLongTasks: stall.longTasks,
      stallLongTaskMs: stall.longTaskMs,
      workerErrors: workerErrors.length,
      roundsPerSiblingEditInNonEditingTab: round(
        medianOrNull(roundsPerSiblingEdit),
        2
      ),
      serverBytesPerEditPerTab: round(
        perEditPerTab(before, after, "bytes", ROUNDS),
        0
      ),
      storageWritesPerEditPerTab: round(
        perEditPerTab(before, after, "writes", ROUNDS),
        2
      ),
      bootServerLastMs: maxOrNull(connected),
    };

    const rows: Array<
      [string, number | boolean | null, "ms" | "MB" | "n" | "ok"]
    > = [
      [`open ${N} tabs, wall clock`, result.openMs, "ms"],
      [`boot → repo, last of ${N} tabs`, result.bootRepoMs, "ms"],
      [`boot → linked, last of ${N} tabs`, result.bootLinkedMs, "ms"],
      [`boot → server connected, last of ${N} tabs`, result.bootServerMs, "ms"],
      [`renderer memory, ${N} tabs`, result.memoryMb, "MB"],
      [`renderer processes, ${N} tabs`, result.processes, "n"],
      [`${N - 1} tabs find the doc: median`, result.findMedianMs, "ms"],
      [`${N - 1} tabs find the doc: slowest`, result.findSlowestMs, "ms"],
      [`…all ${N - 1} found it`, result.allFound, "ok"],
      [`…finds that needed a retry (of ${N - 1})`, result.retried, "n"],
      [`edit → seen in ${N - 1} tabs: median tab`, result.seenMedianMs, "ms"],
      [`edit → seen in ${N - 1} tabs: slowest tab`, result.seenSlowestMs, "ms"],
      [`…tabs that saw every edit (of ${N - 1})`, result.tabsSawEveryEdit, "n"],
      [`edit → server holds our heads (${N} tabs)`, result.confirmMedianMs, "ms"],
      [`…server confirmed every edit (${N} tabs)`, result.allConfirmed, "ok"],
      [`…longest main-thread stall in tab 0 during the edits`, result.stallMaxMs, "ms"],
      [`sync rounds per sibling edit, non-editing tab`, result.roundsPerSiblingEditInNonEditingTab, "n"],
      [`server bytes received per edit per tab`, result.serverBytesPerEditPerTab, "n"],
      [`storage writes (saveBatch) per edit per tab`, result.storageWritesPerEditPerTab, "n"],
      [`worker errors (${N} tabs)`, result.workerErrors, "n"],
    ];
    for (const [metric, value, unit] of rows) {
      record({ metric, mode, value, unit });
    }
    console.log(`SCALE_RESULT ${JSON.stringify(result)}`);
  });
}
