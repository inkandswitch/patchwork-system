---
"@inkandswitch/patchwork-providers": patch
---

A remapper can now back a view with a document that's never saved or synced. `DocHandleDescriptor` gains `scratchUrl`, naming a document in the realm's scratch repo (a storage-less, network-less `Repo`, from the new `getScratchRepo()`) to show in place of `cloneUrl ?? url` while the view is live. This is for remappers that compute what a document shows rather than store it. A view pinned to heads (on the presented url, or stamped on `cloneUrl`) ignores `scratchUrl` and shows `cloneUrl ?? url` at those heads, since a scratch document needn't keep sharing the history of what it stands for.

While a view is backed by a scratch document, its `OverlayRepo` holds a `repo:scratch-lease` subscription for that document's url, released once nothing forwards to it. A remapper that made the document can claim those leases to know when it's safe to delete it.
