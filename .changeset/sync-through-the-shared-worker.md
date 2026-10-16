---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Tabs now sync through one Subduction node in the automerge protocol handler SharedWorker instead of each opening its own socket to the sync server. The origin has one connection to the server, however many tabs are open.

Each tab's Repo still reads and writes the origin's IndexedDB directly; it passes the node a `subductionRemote` (from the new `getSyncRemote()` export of `@inkandswitch/patchwork-bootloader`) in place of `subductionWebsocketEndpoints`. The node reads back the records a tab stored, pushes them, persists what the server sends, and forwards it to the tabs holding that document. The tab follows the node across worker restarts. The worker's own resolver Repo syncs through the node the same way.

On keyhive sites the node signs as the keyhive identity and stores and forwards the encrypted documents without decrypting them. Each tab's keyhive keeps syncing with the server over the node's connection: `relayKeyhive(repo, remote)` (also new in `@inkandswitch/patchwork-bootloader`) points automerge-repo-keyhive at a relay for keyhive frames.

The shipped automerge-repo patch adds the `subductionRemote` option to `Repo` (the `SubductionRemote` interface), and exports `SubductionStorageBridge`, `INTERCEPTOR_PREFIX` and `SubductionConnections`.
