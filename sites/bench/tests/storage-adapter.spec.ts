import { test } from "@playwright/test";
import {
  STORAGES,
  awaitField,
  createDoc,
  flush,
  marks,
  median,
  online,
  openTab,
  record,
  rendererMemory,
  serverConfirmed,
  setField,
  withStall,
} from "./bench.js";

// IndexedDB in a worker (the shipped adapter: every call is a postMessage
// round trip, the database work happens off the main thread) against
// IndexedDB on the main thread (the plain adapter). Both in `pertab` mode, so
// the adapter is the only thing that differs. Same origin database either way.
const DOCS = 40;
const EDITS_PER_DOC = 20;
const FLUSH_ROUNDS = 20;
const WRITERS = 3;
const SYNC_EDITS = 10;

for (const storage of STORAGES) {
  const mode = "pertab";
  const opts = { server: "none", storage };

  test(`idb ${storage}: write, flush, cold load`, async ({ browser, context }) => {
    const a = await openTab(context, mode, opts);
    record({
      metric: "boot → repo, first tab",
      mode,
      storage,
      value: (await marks(a)).ready,
      unit: "ms",
    });

    // Seed: many docs, each with a run of edits, then one flush for the lot.
    // The stall probe says how much of that the main thread felt.
    const { result: seeded, stall: seedStall } = await withStall(a, () =>
      a.evaluate(
        async ([docs, edits]) => {
          const started = performance.now();
          const urls: string[] = [];
          for (let i = 0; i < docs; i++) {
            const handle = window.repo.create<{
              title: string;
              body: string;
              n: number;
              log: string[];
            }>();
            handle.change((d) => {
              d.title = `doc ${i}`;
              d.body = "x".repeat(2048);
              d.n = 0;
              d.log = [];
            });
            for (let e = 1; e <= edits; e++) {
              handle.change((d) => {
                d.n = e;
                d.log.push(`edit ${e} of doc ${i}`);
              });
            }
            urls.push(handle.url);
          }
          await window.repo.flush();
          return { ms: performance.now() - started, urls };
        },
        [DOCS, EDITS_PER_DOC] as const
      )
    );
    record({
      metric: `create ${DOCS} docs × ${EDITS_PER_DOC} edits, then flush`,
      mode,
      storage,
      value: seeded.ms,
      unit: "ms",
    });
    record({
      metric: "…longest main-thread stall during that",
      mode,
      storage,
      value: seedStall.maxMs,
      unit: "ms",
    });
    record({
      metric: "…main-thread time in long tasks during that",
      mode,
      storage,
      value: seedStall.longTaskMs,
      unit: "ms",
    });

    // One edit at a time, waiting for the disk each time.
    const url = seeded.urls[0];
    const { result: rounds, stall: flushStall } = await withStall(a, () =>
      a.evaluate(
        async ([url, rounds]) => {
          const { handle } = await window.bench.find(url);
          const times: number[] = [];
          for (let i = 1; i <= rounds; i++) {
            const started = performance.now();
            handle.change((d) => {
              d.n = 1000 + i;
            });
            await window.repo.flush([handle.documentId]);
            times.push(performance.now() - started);
          }
          return times;
        },
        [url, FLUSH_ROUNDS] as const
      )
    );
    record({
      metric: "edit → flushed to IndexedDB (median)",
      mode,
      storage,
      value: median(rounds),
      unit: "ms",
    });
    record({
      metric: "…longest main-thread stall during that",
      mode,
      storage,
      value: flushStall.maxMs,
      unit: "ms",
    });

    // A fresh tab loads everything the first one wrote, from disk alone.
    const b = await openTab(context, mode, opts);
    const { result: loaded, stall: loadStall } = await withStall(b, () =>
      b.evaluate(async (urls) => {
        const started = performance.now();
        let first = 0;
        await Promise.all(
          urls.map((url) =>
            window.bench.find(url).then(() => {
              first ||= performance.now() - started;
            })
          )
        );
        return { all: performance.now() - started, first };
      }, seeded.urls)
    );
    record({
      metric: `cold load ${DOCS} docs from storage, all`,
      mode,
      storage,
      value: loaded.all,
      unit: "ms",
    });
    record({
      metric: `cold load ${DOCS} docs from storage, first to arrive`,
      mode,
      storage,
      value: loaded.first,
      unit: "ms",
    });
    record({
      metric: "…longest main-thread stall during that",
      mode,
      storage,
      value: loadStall.maxMs,
      unit: "ms",
    });

    // Several tabs flushing to the same database at once.
    const writers = [a, b];
    while (writers.length < WRITERS) {
      writers.push(await openTab(context, mode, opts));
    }
    const started = Date.now();
    await Promise.all(
      writers.map((page, i) =>
        page.evaluate(
          async ([url, rounds, i]) => {
            const { handle } = await window.bench.find(url);
            for (let r = 1; r <= rounds; r++) {
              handle.change((d) => {
                d[`writer${i}`] = r;
              });
              await window.repo.flush([handle.documentId]);
            }
          },
          [seeded.urls[i + 1], FLUSH_ROUNDS, i] as const
        )
      )
    );
    record({
      metric: `${WRITERS} tabs × ${FLUSH_ROUNDS} edit+flush rounds, concurrently`,
      mode,
      storage,
      value: Date.now() - started,
      unit: "ms",
    });

    await a.waitForTimeout(1_000);
    const memory = await rendererMemory(browser);
    record({
      metric: `renderer memory, ${WRITERS} tabs`,
      mode,
      storage,
      value: memory.mb,
      unit: "MB",
    });
    record({
      metric: "renderer processes",
      mode,
      storage,
      tabs: WRITERS,
      value: memory.processes,
      unit: "n",
    });
  });

  // With a server: does the adapter sit on the path from an edit to the
  // server holding it, or to a sibling seeing it?
  test(`idb ${storage}: sync latency`, async ({ context }) => {
    const a = await openTab(context, mode, { storage });
    const b = await openTab(context, mode, { storage });
    await Promise.all([online(a), online(b)]);
    const url = await createDoc(a, { counter: 0 });
    await awaitField(b, url, "counter", 0);

    const propagation: number[] = [];
    const confirmation: number[] = [];
    for (let i = 1; i <= SYNC_EDITS; i++) {
      const seen = awaitField(b, url, "counter", i);
      const edited = await setField(a, url, "counter", i);
      const [arrived, confirmed] = await Promise.all([
        seen,
        serverConfirmed(a, url),
      ]);
      propagation.push(arrived - edited);
      confirmation.push(confirmed - edited);
    }
    await flush(a);
    record({
      metric: "edit → seen in the other tab (via server)",
      mode,
      storage,
      value: median(propagation),
      unit: "ms",
    });
    record({
      metric: "edit → server holds our heads",
      mode,
      storage,
      value: median(confirmation),
      unit: "ms",
    });
  });
}
