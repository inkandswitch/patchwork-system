---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
---

A restart of the automerge worker no longer makes every tab look up every package at once. Those lookups reached the worker while it was shutting down, and answering them pushed the replacement over its memory threshold, so it recycled again. That kept the worker restarting about every 30s, with package lookups failing with HTTP 556 until the page was reloaded.

The sync node's `changed` now carries its heads for the sedimentree. They're attached only once the tree holds every record that caused the change. Otherwise `changed` comes without them. The node also answers each `watch` with the heads it has, so a replacement node tells watchers what it holds, including anything the node before it stored. `PortSyncRemote.reconnect()` re-sends its watches and no longer calls every watcher.

These are Subduction's heads, not the document's: once a document has a long history they include ancestors of its automerge heads. So they only say whether anything arrived, never which version to load. `watchDocument(url, onChange)` calls `onChange(seen)` with a summary of what the node holds, or with no argument when the node doesn't say. `PackageTracker.watch`'s `onChange` takes the same optional `seen`. `ModuleWatcher` looks a package up when `seen` changes or is absent, and does nothing when a restarted node says the same as before.

A reload also waits for its import to finish before the next one starts, so the changes that land meanwhile collapse into one more import at the latest heads.
