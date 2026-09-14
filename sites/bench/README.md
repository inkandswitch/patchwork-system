# bench

Topology benchmarks for the tab ↔ storage ↔ sync-server arrangement. Not
tests: nothing here gates anything.

```sh
pnpm --filter patchwork-bench bench          # build, run, print the table
pnpm --filter patchwork-bench bench:headed
```

Chromium only (`pnpm exec playwright install chromium` once). Talks to the
real sync server named in the site build, so the server columns need network.
Results land in `bench-results/results.md` and `results.jsonl`.

## Modes

The page at `/` builds one Repo and nothing else — no shell, no account, no
package list — in one of three shapes, chosen by `?mode=`:

| mode | storage | server socket | tabs meet via |
| --- | --- | --- | --- |
| `shared` | subduction SharedWorker | one, in the worker | the worker |
| `pertab` | each tab, same IndexedDB | one per tab | the server (or IndexedDB) |
| `pertab-bc` | each tab, same IndexedDB | one per tab | BroadcastChannel classic sync, then the server |

`shared` is this branch. `?server=none` runs the per-tab modes with no socket.

## What's measured

- `boot.spec` — navigation start → `window.repo`, → server connected, for 1/3/10
  tabs; renderer memory (macOS physical footprint via `footprint`, RSS
  elsewhere) and process count once they're all up.
- `sync.spec` — find a doc a sibling just created (and whether the first
  `find()` settled unavailable); edit → seen in the other tabs; edit → server
  holds our heads. Medians over 10 edits.
- `storage.spec` — a second tab finds the first's doc through storage alone;
  two tabs edit the same doc and close, does a third see everything.
- `offline.spec` — both tabs edit with the network cut, then it returns.
  Per-tab modes only: Playwright's offline emulation cuts a page's own socket
  but not a SharedWorker's.
- `churn.spec` — close the tab that booted everything, check the rest still sync.

Cross-tab timings use epoch milliseconds, since `performance.now()` counts from
each page's own navigation start. `find()` in the helpers retries on
"unavailable" and reports how many tries it took.
