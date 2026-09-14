---
"@inkandswitch/patchwork-bootloader": minor
"@inkandswitch/patchwork": minor
---

Every Repo on the origin is its own Subduction node. A tab holds this origin's IndexedDB, keeps its own WebSocket to the sync server, and meets the other tabs over a BroadcastChannel (`connectSiblings` in `@inkandswitch/patchwork-bootloader/siblings`, classic automerge sync, wrapped in the keyhive adapter on keyhive sites). The automerge SharedWorker no longer sits between tabs and storage — it is one more such node, kept only to resolve `automerge:` URLs for the service worker, which can't own a Repo itself. The websocket proxy worker is gone with it.

Benchmarked against the shared-worker arrangement (`sites/bench`): boot and memory are a wash or better, cross-tab propagation matches, and two shared-worker failures go away — a `find()` racing a sibling's `create()` settled as unavailable, and edits made just before a tab closed were lost, since a storageless tab had nothing to flush to. Each tab flushing its own IndexedDB closes both.

Keyhive sites use the subduction-backed hive in both the tab and the worker, each talking to the sync server directly.

Removed from `setupServiceWorker()`'s result and `patchwork.sw`: `subscribeToRepoChannel`, `getRepoChannel`, `subscribeSyncState`. The `@patchwork/syncstate` BroadcastChannel and its `SyncState*` message types are gone too; a tab's own Repo now has everything they carried — `repo.isSubductionConnected()` and the `subduction-connection` event for the link, `repo.connectedSubductionPeerIds()` for which peers are the server, the `subduction-remote-heads` event and `handle.getSyncInfo()` for per-document heads, and `patchwork.signerIdentity` for this tab's peer id. `createRepo` in `@inkandswitch/patchwork` takes no arguments.

`@inkandswitch/patchwork-bootloader` depends on `@automerge/automerge-repo-network-broadcastchannel`, which is also on the importmap.
