---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
---

IndexedDB is opened on the node's own thread: `createRepo` and the automerge protocol handler worker use `IndexedDBStorageAdapter` in place of `IndexedDBWorkerStorageAdapter`. Measured in `sites/bench`, the worker adapter bought no main-thread time (same boot, same cold load of 40 documents, 1ms flush latency either way) and cost a dedicated worker per tab, about 30 MB across three. The origin-wide signer is unchanged.
