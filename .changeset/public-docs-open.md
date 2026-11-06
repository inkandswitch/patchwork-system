---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-elements": minor
"@inkandswitch/patchwork-bootloader": patch
---

A doc made public ("anyone with the link") opens for someone it isn't shared with. On ARK 0.8 a public doc is granted to patchwork's public reader, not to whoever opens it, and their own keyhive never hears of it (the server only sends an identity the ops that concern it), so patchwork-view's access gate held it back and the pane stayed blank. The gate now asks the public reader, whose fetcher is one of every public doc's members, whether it can read the doc, and checks again each time the reader has read more of keyhive, so a doc made public after it was opened opens too. `setPublicAccess` and `publicAccessChanged` in patchwork-elements (and `hasActiveAccess`, the gate's own check, for anything that wants to say why a view is empty), and `publicReaderCanRead` in the bootloader, are how setup wires that up.
