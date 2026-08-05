---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-filesystem": patch
---

Split the datatype's import URL when creating a doc: `@patchwork.suggestedImportUrl` now holds the URL with the heads stripped, and `@patchwork.frozenImportUrl` holds the full URL including heads. `getFrozenImportUrl` reads the latter. URLs without heads are unchanged and set no `frozenImportUrl`.
