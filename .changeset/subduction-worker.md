---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Split the shared worker in two: a Subduction node that owns storage and the sync-server link, and an automerge worker that only resolves `automerge:` URLs.

automerge-repo now runs only where documents are read: in the tab, and in the automerge worker on the service worker's behalf. Both are storageless nodes hanging off the new subduction worker, which holds this origin's IndexedDB, keeps the WebSocket to the sync server (in-thread now — the websocket proxy worker is gone), and relays documents, edits and ephemeral messages between everything connected to it.

A SharedWorker can neither spawn nor connect to another SharedWorker, so a tab brokers the link between the two: it opens a port on the subduction worker and donates it to the automerge worker with `donatePort`.

Sites get a new emitted worker, `subduction-worker.js`; `setupServiceWorker` takes `subductionWorkerPath` alongside `workerPath`. Sync-state subscriptions now come from the subduction worker, which compares its own sedimentree heads against the server's rather than a document's Automerge frontier.

Keyhive sites are not covered by this split yet.
