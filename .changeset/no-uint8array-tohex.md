---
"@inkandswitch/patchwork": patch
---

`createRepo` formats the tab's subduction verifying key as hex by hand, not with `Uint8Array.prototype.toHex`. `toHex` arrived in Safari 18.2, so on Safari 18.1 and the iOS versions that ship with it, Patchwork failed to boot at that log line.
