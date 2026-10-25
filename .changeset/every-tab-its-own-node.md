---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-filesystem": patch
---

Every tab is its own Subduction node again, with its own socket to the sync server. The sync node in the automerge worker is gone. When the worker restarts (to recycle its wasm memory, for a new build, or after a trap), it takes only its resolver Repo with it. Before, every restart threw away the node every tab synced through, and each tab had to reconnect and resubscribe. The worker's resolver Repo has its own socket too.

The automerge worker still holds `AUTOMERGE_WORKER_LOCK` for as long as it lives. The lock now does one thing: it lets tabs and the service worker tell when the worker has died. A replacement no longer waits for it before it builds its Repo, answers handoffs or announces itself `online`. An instance that's restarting already stops taking handoffs and package-memory requests, so the two don't answer at once.

Removed from `@inkandswitch/patchwork-bootloader`: `getSyncRemote`, `watchDocument`, `relayKeyhive` and the `PortSyncRemote` type. Pass `subductionWebsocketEndpoints: [syncServerUrl]` to the Repo instead of `subductionRemote: getSyncRemote()`. On keyhive sites, use `new Repo(config)` directly rather than wrapping it in `relayKeyhive`. `loadKeyhiveSigner` is gone from `@inkandswitch/patchwork-bootloader/signer`. `startWorkerControl` no longer returns `holding`.

Tabs still follow package docs without loading them. `watchDocument(repo, url, onChange)`, now exported from `@inkandswitch/patchwork`, subscribes to the document through the tab's own Subduction connection and listens on the origin's heads channel. Every Repo relays the server's heads there, so the watcher hears both the server's pushes and other tabs' writes. `onChange(seen)` gets the same summary `ModuleWatcher` already compares, so a repeat costs no lookup. Subduction can't unsubscribe from a single document, so after `unwatch()` the server keeps pushing it to that tab until the connection drops.
