---
"@inkandswitch/patchwork-plugins": patch
---

Omit `suggestedImportUrl` and `frozenImportUrl` from a new doc's `@patchwork` metadata when there is no value for them, instead of writing `undefined`.
