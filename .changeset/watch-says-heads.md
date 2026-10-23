---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
---

A restart of the automerge worker no longer makes every tab look up every package at once. Those lookups reached the worker while it was shutting down, and answering them pushed the replacement over its memory threshold, so it recycled again. That kept the worker restarting about every 30s, with package lookups failing with HTTP 556 until the page was reloaded.

The sync node's `changed` now carries the document's heads, read from the node's own tree, which are its automerge heads. They're attached only once the tree holds every record that caused the change. Otherwise `changed` comes without heads and the watcher looks the document up, as before. The node also answers each `watch` with the heads it has, so a replacement node tells watchers where their documents are, including anything the node before it stored. `PortSyncRemote.reconnect()` re-sends its watches and no longer calls every watcher.

`watchDocument(url, onChange)` calls `onChange(latest)` with the document's url at those heads, or with no argument when the node doesn't know them. `PackageTracker.watch`'s `onChange` takes the same optional `latest`. `ModuleWatcher` does nothing when `latest` is the version it already has, and imports `latest` without a lookup when it's newer. It only trusts `latest` once a lookup has settled which doc the package is, so a branches doc is still followed to its default branch.
