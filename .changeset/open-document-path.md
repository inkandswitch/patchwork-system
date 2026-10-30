---
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork": patch
---

`patchwork:open-document` (and `openDocument`, `patchwork.open`, `<patchwork-view path>`) can say where a document was opened from: `path` is the live path it was opened at, like a cwd, e.g. `<acctHash>/Projects/foo` with each segment `encodeURIComponent`-encoded. A `<patchwork-view>` hands a new path to its tool without remounting it.
