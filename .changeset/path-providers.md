---
"@inkandswitch/patchwork-filesystem": patch
---

`resolvePath` walks documents through path providers. A `PathProvider` says how one kind of document is walked: `lookup(node, names)` finds a child and reports how many names it used, and `list(node)` gives every child. Following a link to the next document is the walker's job, so a provider only ever reads the node it is given. `directoryProvider` and `folderProvider` replace the two built-in folder strategies and resolve the same paths as before. `PathProvider`, `Child`, `Lookup`, `providerFor`, `PROVIDERS` and `asLink` are exported from `@inkandswitch/patchwork-filesystem`; `FolderStrategy` stays as a deprecated alias of `PathProvider`.
