# bench

Benchmarks for the tab ↔ automerge worker ↔ sync-server arrangement Patchwork
ships. Not tests: nothing here gates anything.

```sh
pnpm --filter patchwork-bench bench          # build, run, print the tables
pnpm --filter patchwork-bench bench:headed
```

Chromium by default (`pnpm exec playwright install chromium` once). Talks to the
real sync server named in the site build, so the server columns need network.
Results land in `bench-results/results.md` and `results.jsonl`. Port 5199 has
to be free: a `vite preview` left behind by another checkout would otherwise be
reused and serve its build, so the run refuses one instead.

On a pull request, CI benches Patchwork as it ships (`patchwork` mode only),
on main and on the PR, three rounds each, alternating, on the same runner, and
comments only the comparison: `node compare.ts --main <bench-results>... --pr
<bench-results>...` puts the runs side by side, a median and range per side,
and flags a benchmark only when every run of the PR landed on the same side of
every run of main, with the medians more than 20% apart.

## What the page is

The page at `/` builds the tab Repo Patchwork ships, `createRepo()`, and
nothing else: no shell, no account, no package list. The tab's Repo runs on a
`PortBackend` that forwards over a MessagePort to the one `SubductionBackend`
in the automerge SharedWorker, which owns IndexedDB and the socket to the sync
server. So every tab on the origin is one node on one socket, and the tabs meet
in the worker. There is one mode, `patchwork`; the topologies earlier versions
of this bench compared (a subduction node per tab, a node in a dedicated or
shared worker, BroadcastChannel meshes, the IndexedDB worker storage adapter,
`?heads=`, `?bc=`, `?throttle=`, `?signer=`, `?server=none`) were automerge-repo
2 arrangements and no longer exist: a Repo has one backend, and there are no
storage or network adapters.

Query params: `?open=<automerge url>` finds that doc first and marks `doc`;
`?stop=js|wasm` stops the boot early (memory.spec's baselines); `?ui` adds a
small playground.

`window.bench` is what the specs drive: `marks`, `find`, `online` (the worker
reports connected), `isOnline`, `setOffline`, `serverPeerIds`, `serverHeads` and
`serverConfirmed`, `stallStart`/`stallStop`. `serverBytes`, `storageWrites` and
`syncRounds` return null: the socket, storage and sync rounds are in the
worker, which keeps no counters, so the tab can't measure them and those rows
print as –. `workerErrors`, `workerLog` and `remoteHeadsSeen` went with the
bench's own workers.

How the server is observed: the server's heads for a document arrive as the
handle's `remote-heads` events, relayed through the worker, as UrlHeads, like
`handle.heads()`. `serverConfirmed` waits until every head of the tab's is
among the server's.

The offline switch is `PortBackend.setOffline`, which cuts and restores the
worker's socket. Playwright's `setOffline` and `routeWebSocket` can't reach a
SharedWorker's socket (checked: a refused WebSocket route leaves the worker
online), so storage.spec cuts the worker the same way before any doc exists,
which keeps the server from ever having the doc.

## What's measured

- `boot.spec` — navigation start → `window.repo`, → server connected, for 1/3/10 tabs; renderer memory
  (macOS physical footprint via `footprint`, RSS elsewhere) and process count
  once they're all up.
- `sync.spec` — find a doc a sibling just created (and whether the first
  `find()` settled unavailable); edit → seen in the other tabs; edit → server
  holds our heads; and whether a client in a fresh browser context can get
  the finished doc from the server. Medians over 10 edits.
- `storage.spec` — a tab writes, flushes and closes; a fresh tab finds the doc
  through storage alone (the worker's server link is cut before the doc exists).
  Two tabs edit the same doc and close, does a third see everything.
- `offline.spec` — both tabs edit with the worker's link to the server cut,
  then it returns. Recorded: whether the link was seen down for the whole
  stretch, whether a stranger could see the offline edits at the server (it
  shouldn't), whether the two tabs converged while offline (they share the
  worker), and the reconnect → converged time only where they hadn't.
- `churn.spec` — close the tab that booted everything, check the rest still sync.
- `open.spec` — a doc only the server has, opened (`?open=<url>`) in tab after
  tab of one context: navigation start → the doc in hand, for the first tab
  and the tenth.
- `scale.spec` — 40 tabs on one doc (`SCALE_TABS`, `SCALE_DOC_KB`): find,
  edit → seen, edit → server confirmed, main-thread stall, memory.
- `memory.spec` — memory by scenario (bare page, bundle, wasm, patchwork with a
  shared doc) at 1 and 10 tabs; chromium only.
- `evict.spec` — `repo.removeFromCache` frees memory, and the doc comes back
  with the same text and heads, sees a sibling's edit, and keeps an unflushed one.

Cross-tab timings use epoch milliseconds, since `performance.now()` counts from
each page's own navigation start. `find()` in the helpers retries on
"unavailable" and reports how many tries it
took.

Each run truncates `bench-results/results.jsonl`; `BENCH_APPEND=1` keeps the
earlier rows, for re-running one spec or one mode into the same table.
