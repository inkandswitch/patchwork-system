---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-filesystem": patch
---

Every tab is its own Subduction node again, with its own socket to the sync server. The sync node in the automerge worker is gone. When the worker restarts (to recycle its wasm memory, for a new build, or after a trap), it takes only its resolver Repo with it. Before, every restart threw away the node every tab synced through, and each tab had to reconnect and resubscribe. The worker's resolver Repo has its own socket too.

The automerge worker still holds `AUTOMERGE_WORKER_LOCK` for as long as it lives. The lock now does one thing: it lets tabs and the service worker tell when the worker has died. A replacement no longer waits for it before it builds its Repo, answers handoffs or announces itself `online`. An instance that's restarting already stops taking handoffs and package-memory requests, so the two don't answer at once.

Removed from `@inkandswitch/patchwork-bootloader`: `getSyncRemote`, `watchDocument`, `relayKeyhive` and the `PortSyncRemote` type. Pass `subductionWebsocketEndpoints: [syncServerUrl]` to the Repo instead of `subductionRemote: getSyncRemote()`. On keyhive sites, use `new Repo(config)` directly rather than wrapping it in `relayKeyhive`. `loadKeyhiveSigner` is gone from `@inkandswitch/patchwork-bootloader/signer`. `startWorkerControl` no longer returns `holding`.

The tab now watches package docs in its own Repo (`trackPackagesInRepo(repo).watch`), so each watched package's doc is held in the tab again. They're still looked up at their latest heads through the service worker.
