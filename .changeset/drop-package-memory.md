---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
---

The automerge worker no longer measures package memory. Removed: the `@patchwork/package-memory` channel and its message types (`PACKAGE_MEMORY_CHANNEL`, `PackageMemoryRequestMessage`, `PackageMemoryDocument`, `PackageMemoryAcceptedMessage`, `PackageMemoryReplyMessage`), and the records a restarting worker saved for its replacement (`LOADED_CACHE`). The service worker clears that cache along with every other cache but its own. `packageDocuments` is gone from `@inkandswitch/patchwork-filesystem`; nothing else walked a package.
