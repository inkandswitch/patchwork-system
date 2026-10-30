---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

A pinned URL to a file in a package's nested folder keeps working after the file, or a folder above it, is renamed. A file list now records `via` for such a file: the heads of each nested folder doc on the way to it. The service worker passes those on with `heads` when it asks a resolver for the file, and `readPath` reads any document it reaches by a link without heads at whichever of them it has. Before, the walk read nested folders as they are now, so a renamed file answered nothing when its bytes weren't already stored.

Lists with no nested folders leave `via` out and hash as before. A package with nested folders gets a new list, and so a new pinned URL, once.
