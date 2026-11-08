---
"@inkandswitch/patchwork-providers": patch
---

A remapper can now show a view a document that's never saved or synced. `DocHandleDescriptor` gains `scratchUrl`, a document in the realm's scratch repo (a storage-less, network-less `Repo`, from the new `getScratchRepo()`) to show in place of `cloneUrl ?? url` while the view is live. This is for remappers that compute what a document shows rather than store it, and so can stack over a draft: the descriptor keeps the draft's `cloneUrl` alongside. A scratch document should start as a fork of what it stands for but needn't keep sharing its history, so a view pinned to heads (on the presented url, or stamped on `cloneUrl`) never shows it, and shows `cloneUrl ?? url` at those heads instead.

While a view is backed by a scratch document, its `OverlayRepo` holds a `repo:scratch-lease` subscription for that document's url: opened before it finds the document, and closed once nothing forwards to it (after swapping to another backing, or on dispose). A remapper that made the document can claim those leases to know when it's safe to delete it.

`OverlayRepo` takes an optional third argument, `{ scratchRepo }`, to find scratch documents somewhere other than the realm's scratch repo.
