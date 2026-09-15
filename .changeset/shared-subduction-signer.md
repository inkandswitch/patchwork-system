---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Persist the Subduction signer so every context on an origin presents the same identity. The seed lives in the shared IndexedDB, so tabs and the automerge protocol handler worker adopt one signer instead of each minting a fresh `MemorySigner` on load. Generating it takes a Web Lock, so a cold profile opening two contexts at once still settles on one seed.

`@inkandswitch/patchwork-bootloader/signer` is a new export: `loadOrCreateSigner(storage)` returns the origin's `MemorySigner`, generating and storing a seed the first time.
