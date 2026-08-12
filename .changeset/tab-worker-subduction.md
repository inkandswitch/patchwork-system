---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Sync the tab with the automerge SharedWorker over Subduction instead of classic automerge-repo sync.

The tab is now a storageless node: it holds no IndexedDB of its own and gets everything from the worker over a Subduction transport on the repo port. Keyhive sites are unchanged — they keep classic sync through the keyhive network adapter.

New: `@inkandswitch/patchwork-bootloader/worker-link` exports `MessagePortTransport`, a Subduction transport over a MessagePort, and `WorkerSubductionEndpoint`, which opens one per connection. The tab passes the endpoint as a `subductionWebsocketEndpoint`, so automerge-repo's own reconnect loop replaces the port re-wiring the tab used to do by hand.

The worker handoff on `patchwork.sw` changed with it: `subscribeToRepoChannel(listener)` and `getRepoChannel()` are gone, replaced by `openPort(): Promise<MessagePort>` and `onRecreated(listener)`. `createRepo` in `@inkandswitch/patchwork` takes those two rather than a network adapter.
