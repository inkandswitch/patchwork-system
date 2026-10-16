---
"@inkandswitch/patchwork-bootloader": patch
---

The sync node no longer writes a tab's records to IndexedDB a second time. When a tab stores a change, the node reads it back to add it to its own tree, and that used to write the same records again — four sequential IndexedDB writes per edit, byte for byte what the tab had just written, holding up the sync round that pushes the edit to the server. The node now skips those writes, which halves the writes per edit and keeps them off the path to the server when the database is busy.
