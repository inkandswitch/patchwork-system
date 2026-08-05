---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-filesystem": patch
---

Store the datatype's import URL without heads in `@patchwork.suggestedImportUrl`, and record the heads separately in `@patchwork.suggestedImportUrlHeads`. A doc created from a package pinned to specific heads now suggests the package itself, with the pin kept alongside it.
