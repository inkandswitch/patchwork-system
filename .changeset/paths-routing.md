---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

The router keeps `&path=` in the hash: the live path a document was opened at (`<acctHash>/Projects/foo`), written whenever `patchwork:open-document` carries one and its segments kept exactly as encoded. A hash with `path=` and no `doc=` opens what the path names. When `doc=` and `path=` disagree, because something moved or was renamed, `doc=` wins and `path=` is dropped with a console warning. Only paths under the site's own account resolve. The e2e suite gains a test that opens a document from `&path=` alone.
