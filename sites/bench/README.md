# bench

Topology benchmarks for the tab ↔ storage ↔ sync-server arrangement, and for
where IndexedDB runs. Not tests: nothing here gates anything.

```sh
pnpm --filter patchwork-bench bench          # build, run, print the tables
pnpm --filter patchwork-bench bench:headed
```

Chromium only (`pnpm exec playwright install chromium` once). Talks to the
real sync server named in the site build, so the server columns need network.
Results land in `bench-results/results.md` and `results.jsonl`.

## Modes

The page at `/` builds one Repo and nothing else — no shell, no account, no
package list — in one of five shapes, chosen by `?mode=`:

| mode | subduction node | storage | server socket | tabs meet via |
| --- | --- | --- | --- | --- |
| `patchwork` | in the tab | each tab, IndexedDB worker | one per tab | the siblings BroadcastChannel (subduction mesh), then the server |
| `pertab` | in the tab | each tab, IndexedDB worker | one per tab | the server (or IndexedDB) |
| `pertab-bc` | in the tab | each tab, IndexedDB worker | one per tab | classic automerge sync over a BroadcastChannel, then the server |
| `tab-worker` | a dedicated Worker per tab | the worker, in-thread IndexedDB | one per worker | a BroadcastChannel mesh between the workers, then the server |
| `shared-worker` | one SharedWorker | the worker, in-thread IndexedDB | one | the worker |

`patchwork` is `createRepo()` as shipped, plus the service worker and the
automerge worker that resolves URLs for it; the other four are built in the
page. In the two worker modes the tab's Repo has no storage and one subduction
peer, its worker, reached over a MessagePort (`src/worker-link.ts`); the worker
runs a Repo of its own as the node (`src/node.ts`) but never opens a document.
`?server=none` runs every non-patchwork mode with no socket.

`?storage=direct` swaps the IndexedDB worker adapter for in-thread IndexedDB in
the bare per-tab modes; `storage-adapter.spec` compares the two in `pertab`.

The sync server's subduction peer id is learned once per run from a bare tab
in a throwaway context and passed to every page as `?serverPeer=`, so "the
server holds our heads" means that peer and not a sibling.

## What's measured

- `boot.spec` — navigation start → `window.repo`, → server connected (and, in
  the worker modes, → linked to the worker), for 1/3/10 tabs; renderer memory
  (macOS physical footprint via `footprint`, RSS elsewhere) and process count
  once they're all up.
- `sync.spec` — find a doc a sibling just created (and whether the first
  `find()` settled unavailable); edit → seen in the other tabs; edit → server
  holds our heads. Medians over 10 edits.
- `storage.spec` — a second tab finds the first's doc through storage alone;
  two tabs edit the same doc and close, does a third see everything.
- `offline.spec` — both tabs edit with the network cut, then it returns.
  Playwright's offline emulation reaches a tab's own socket but not a worker's,
  so the worker modes are also told to drop the server link and hold off
  reconnecting; whether the link was actually seen down is recorded.
- `churn.spec` — close the tab that booted everything, check the rest still sync.
- `storage-adapter.spec` — in `pertab`, IndexedDB worker vs in-thread: create
  40 docs × 20 edits and flush, edit → flushed latency, cold load of the 40
  from a fresh tab, three tabs flushing concurrently, sync latency with the
  server; with the longest main-thread stall (a 5ms timer's lateness) and long
  task time recorded around the heavy parts.

Cross-tab timings use epoch milliseconds, since `performance.now()` counts from
each page's own navigation start. `find()` in the helpers retries on
"unavailable" and reports how many tries it took.
