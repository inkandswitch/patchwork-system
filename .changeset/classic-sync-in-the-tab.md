---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Classic automerge-repo sync connects from the tab's own Repo instead of the automerge worker, so a worker restart no longer drops it and tabs no longer ask the replacement to connect again.

`connectClassicSync` in `@inkandswitch/patchwork-bootloader` now takes the Repo: `connectClassicSync(repo, server?)`. `setupServiceWorker()` no longer returns `connectClassicSync`. `patchwork.sw.connectClassicSync(server?)` works as before. The `ConnectClassicSyncMessage` type is gone.
