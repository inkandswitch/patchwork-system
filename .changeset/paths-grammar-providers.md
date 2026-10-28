---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-plugins": patch
---

Add paths. `idhash`, `livePath` and `parsePath` read and write live paths (`<acctHash>/Projects/foo`) and pinned ones (`<acctHash>@<heads>/<idhash>@<heads>/…`). `resolveLivePath`, `pinnedPath`, `pinPath`, `listChildren` and `listUnion` walk an account's namespace to find a document or pin a path. Path providers (`PathProvider`, `accountProvider`, `directoryProvider`, `folderProvider`, `branchesProvider`, `providerFor`) replace `FolderStrategy`, which is now a deprecated alias of `PathProvider`. `resolvePath` now also follows a branches doc to its default branch. `AccountDoc` gains an optional `namespace` mount table; without one, `/` is `rootFolderUrl`. Nothing calls the new path helpers yet.
