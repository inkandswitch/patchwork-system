---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Sync the tab with the automerge SharedWorker over Subduction instead of classic automerge-repo sync.

The tab is now a storageless node: it holds no IndexedDB of its own and gets everything from the worker's repo over a Subduction transport, one per repo port. Keyhive sites are unchanged — they keep classic sync through the keyhive network adapter.

New: `@inkandswitch/patchwork-bootloader/port-hub` exports `PortHubAdapter`, a network adapter that carries many MessagePorts, and `WORKER_SUBDUCTION_SERVICE`, the service name both ends of the link name. `subductionAdapters` is read once when a Repo is built, and ports come and go after that — the worker gains one per tab, a tab gets a fresh one whenever the worker is recreated — so both ends register a hub up front and add ports to it.

`createRepo` in `@inkandswitch/patchwork` now takes the worker's `MessagePort` rather than a `MessageChannelNetworkAdapter`, and returns `rewire(port)` and `linked()` alongside the repo.
