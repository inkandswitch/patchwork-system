---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

The tab no longer heartbeats the automerge SharedWorker. The ping/pong, the second-connection probe, instance ids, and the recovery rate limit are gone: since every tab is its own Subduction node, the worker's control port carries only console forwarding, a debug toggle, and `connectClassicSync`, so a silent port strands nothing. The worker is respawned on the next `get()` if the browser terminates it (its control port fires `close`). `SharedWorkerHandle.onRecreated` is removed; it had no listeners. `@inkandswitch/patchwork` drops its page-lifecycle logging, which existed to line up against sync-socket reaps in a worker that no longer holds the tab's socket.
