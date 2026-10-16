---
"@inkandswitch/patchwork-bootloader": patch
---

The sync node now passes a tab's change on to the other tabs holding that document as soon as it has read it back, instead of after storing it into its own tree. The writing tab has already saved the change, so nothing waits on the node's store; with ten tabs open, the other tabs see an edit in roughly half the time.
