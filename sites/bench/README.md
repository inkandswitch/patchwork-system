# bench

Topology benchmarks for the tab ↔ storage ↔ sync-server arrangement, and for
where IndexedDB runs. Not tests: nothing here gates anything.

```sh
pnpm --filter patchwork-bench bench          # build, run, print the tables
pnpm --filter patchwork-bench bench:headed
```

Chromium only (`pnpm exec playwright install chromium` once). Talks to the
real sync server named in the site build, so the server columns need network.
Results land in `bench-results/results.md` and `results.jsonl`. Port 5199 has
to be free: a `vite preview` left behind by another checkout would otherwise be
reused and serve its build, so the run refuses one instead.

## Modes

The page at `/` builds one Repo and nothing else — no shell, no account, no
package list — in one of six shapes, chosen by `?mode=`:

| mode | subduction node | storage | server socket | tabs meet via |
| --- | --- | --- | --- | --- |
| `patchwork` | in the tab | each tab, in-thread IndexedDB | one per tab | the siblings BroadcastChannel (subduction mesh), then the server |
| `pertab` | in the tab | each tab, in-thread IndexedDB | one per tab | the server (or IndexedDB) |
| `pertab-bc` | in the tab | each tab, in-thread IndexedDB | one per tab | classic automerge sync over a BroadcastChannel, then the server |
| `pertab-mesh` | in the tab | each tab, in-thread IndexedDB | one per tab | patchwork's siblings mesh (subduction over a BroadcastChannel), each tab signing as itself |
| `tab-worker` | a dedicated Worker per tab | the worker, in-thread IndexedDB | one per worker | a BroadcastChannel mesh between the workers, then the server |
| `shared-worker` | one SharedWorker | the worker, in-thread IndexedDB | one | the worker |

`patchwork` is `createRepo()` as shipped, plus the service worker and the
automerge worker that resolves URLs for it (that worker builds its Repo on the
first URL it is asked to resolve, so in this bench it is a spawned but idle
process); the other four are built in the page. In the two worker modes the tab's Repo has no storage and one subduction
peer, its worker, reached over a MessagePort (`src/worker-link.ts`); the worker
runs a Repo of its own as the node (`src/node.ts`) but never opens a document.
A node like that stores what a tab pushes and answers what a peer asks, but
doesn't carry one peer's commits to another on its own, so when a tab (or a
mesh peer) announces heads the node runs a sync round for that document with
every peer. `?server=none` runs every non-patchwork mode with no socket.

Two things the worker modes show that aren't bugs in the bench: a `find()`
that races a sibling's `create()` settles unavailable, and a plain second
`find()` returns the same settled query (the entry stays initializing, so data
arriving later is skipped) — the helpers' `find` calls
`repo.resyncSubduction()` between tries, which is what an app would have to
do; and a storageless tab's `flush()` resolves before its commits have reached
the worker, so edits made just before the tab closes can be lost — a dedicated
worker dies with its tab and a SharedWorker with its last tab, mid-write. Closing
right after `flush()` loses the whole doc; 300ms later everything is on disk.
`sync.spec` measures the race with disposable tabs and carries on with fresh
ones.

A closed tab's mesh peer lingers: the BroadcastChannel adapter only announces a
departure from `disconnect()`, which a closing tab (or its terminated worker)
never calls, so in `patchwork`, `pertab-mesh` and `tab-worker` the survivors
keep a phantom peer. `churn.spec` is where that would show.

`?storage=worker` swaps in-thread IndexedDB for the IndexedDB worker adapter in
the bare per-tab modes; `storage-adapter.spec` compares the two in `pertab`.
`?mesh=1` and `?signer=shared` add patchwork's siblings mesh and its
origin-wide signer (`@inkandswitch/patchwork-bootloader/signer`) to any bare
mode, so the shipped topology can be taken apart one piece at a time
(`pertab-mesh` is `pertab&mesh=1`; `pertab&mesh=1&signer=shared` is `patchwork`
minus the service worker and the idle automerge worker).

`patchwork` and `pertab-mesh` differ in the signer. With the origin-wide signer
every tab presents the same subduction peer id, and with three tabs open the
third stops receiving a sibling's edits over the mesh and the server stops
confirming that sibling's heads — every run, in `patchwork`, in
`pertab&mesh=1&signer=shared`, and in a keyhive build of `patchwork`
(`keyhive: true` in vite.config.ts), whose signer ARK derives from the keypair
every context shares. With per-tab signers (`pertab-mesh`) the same mesh
converges. The mechanism is in subduction-core: connections are keyed by peer
id, a sync round stops at the first connection of a peer that answers, and
relays exclude every connection of the sender's id.

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
  holds our heads; and whether a client in a fresh browser context can get
  the finished doc from the server. Medians over 10 edits.
- `storage.spec` — a tab writes, flushes and closes; a fresh tab finds the doc
  through storage alone (no server; patchwork's server is build-time, so its
  WebSockets are refused instead). Two tabs edit the same doc
  and close, does a third see everything.
- `offline.spec` — both tabs edit with the link to the server cut, then it
  returns. Playwright's `setOffline` fails new connections like a dead network
  but doesn't close a socket that's already open, so the tabs' sockets are also
  proxied (`context.routeWebSocket`) purely to close the live ones; a worker's
  socket is out of reach of both, so the worker node is told to drop it and
  fails its connect attempts while offline. automerge-repo's reconnect backoff
  then applies in every mode. Recorded: whether
  the tab modes' link was seen down, whether a stranger could see the offline
  edits at the server (it shouldn't), whether the two tabs converged while
  offline over a local channel, and the reconnect → converged time only where
  they hadn't.
- `churn.spec` — close the tab that booted everything, check the rest still sync.
- `storage-adapter.spec` — in `pertab`, IndexedDB worker vs in-thread: create
  40 docs × 20 edits and flush, edit → flushed latency, cold load of the 40
  from a fresh tab, three tabs flushing concurrently, sync latency with the
  server; with the longest main-thread stall (a 5ms timer's lateness) and long
  task time recorded around the heavy parts.

Cross-tab timings use epoch milliseconds, since `performance.now()` counts from
each page's own navigation start. `find()` in the helpers retries on
"unavailable" (with a real re-sync each time) and reports how many tries it
took.

Each run truncates `bench-results/results.jsonl`; `BENCH_APPEND=1` keeps the
earlier rows, for re-running one spec or one mode into the same table.
