---
"@inkandswitch/patchwork": patch
---

The shipped automerge-repo patch no longer adds `subductionRemote`, the option that let a Repo sync through another node; nothing uses it since every tab became its own node again. The `SubductionRemote`, `SubductionRemoteHandlers` and `SubductionRemoteSyncResult` types are gone, as are the `SubductionStorageBridge`, `INTERCEPTOR_PREFIX` and `SubductionConnections` exports. `subductionSaveThrottle` stays. A site applying the patch from `@inkandswitch/patchwork/dist/patches` should take the new one.
