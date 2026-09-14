---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Split the shared worker in two: a Subduction node that owns storage and the sync-server link, and an automerge worker that only resolves `automerge:` URLs.

automerge-repo now runs only where documents are read: in the tab, and in the automerge worker on the service worker's behalf. Both are storageless nodes hanging off the new subduction worker, which holds this origin's IndexedDB, keeps the WebSocket to the sync server (in-thread now — the websocket proxy worker is gone), and relays documents, edits and ephemeral messages between everything connected to it.

A SharedWorker can neither spawn nor connect to another SharedWorker, so a tab brokers the link between the two: it opens a port on the subduction worker and donates it to the automerge worker with `donatePort`.

Sites get a new emitted worker, `subduction-worker.js`; `setupServiceWorker` takes `subductionWorkerPath` alongside `workerPath`. Sync-state subscriptions now come from the subduction worker, which compares its own sedimentree heads against the server's rather than a document's Automerge frontier.

On a keyhive site the tab's hive addresses the subduction worker rather than the sync server: keyhive frames are point-to-point, so the worker relays them — a tab's to the server, the server's to every tab — without a hive of its own. `setupServiceWorker` returns `identity()` so a tab can find the worker's peer id. The automerge worker has no hive either, so it can't resolve `automerge:` URLs to keyhive-protected documents.
