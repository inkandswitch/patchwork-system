---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

Tools can ask the automerge worker how much memory a package's documents take to load, so a packages view can show which packages are the expensive ones. The worker is what loads a package's documents to serve its files, so it measures them there rather than in the tab asking.

- `PACKAGE_MEMORY_CHANNEL` (`@patchwork/package-memory`, in `@inkandswitch/patchwork-bootloader/types`): post a `PackageMemoryRequestMessage` with the package's root URL. The worker answers `accepted` straight away, then a `PackageMemoryReplyMessage` listing documents with their path, ops, changes, the ops in their biggest single change, and how a file's `content` is stored (text, `ImmutableString` or bytes) and its length.
- By default the answer is what the worker has loaded of the package since it started, each document measured as it was loaded to serve a file: what the package actually costs, and asking loads nothing. With `walk: true` the worker loads every document in the package to measure it, a package at a time and a document at a time, letting each go once it's measured unless a file is being resolved meanwhile, and fetching any it hasn't stored. That covers files nothing has asked for, like READMEs and lockfiles, but it's slow, and measuring a document with one huge change costs the worker as much memory as loading it does. A document that can't be found within 15s is listed with the error and the walk goes on.
- The biggest change is the number to look at. What a load costs grows faster than its ops, and much faster for one big change: a file's text written as a plain string in one change is an op per character, all in that change, and one of 585k characters took ~300 MB of wasm memory to load.
- `packageDocuments(repo, root)` in `@inkandswitch/patchwork-filesystem` walks every document `resolvePath` can reach from a package's root (directory and folder docs, links as strings or `ImmutableString`s), root first, finding each only when it's reached.
