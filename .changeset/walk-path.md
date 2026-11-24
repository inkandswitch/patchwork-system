---
"@inkandswitch/patchwork-filesystem": patch
---

A written path resolves to a document. `walkPath(repo, path, { accounts })` walks a live path, a pinned path or a share link through the path providers and says where it ended: the handle (as a view at the heads it was read at), the node, whether that is the document itself or a value inside it, and the path's pinned form. In the pinned form every container the walk entered is written as `<idhash>@<heads>`, and the names from the last container to a file stay names. `canonical` is true when the input was already that pinned form. `resolveLivePath` gives just the handle: the view for a canonical pinned path, the live handle otherwise. `accounts` maps an account's idhash to its url, and `find` lets a caller decide how a document is found. Both functions are exported from `@inkandswitch/patchwork-filesystem`.
