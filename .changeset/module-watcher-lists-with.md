---
"@inkandswitch/patchwork-filesystem": patch
---

`ModuleWatcher.listsWith(entry)` says which package lists have `entry` in them, by name, with the url each list is read from. A package-list adder in the package database records only the entry, so this is how something showing a package says which of your lists brought it.
