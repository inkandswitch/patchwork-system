---
"@inkandswitch/patchwork-filesystem": patch
---

Paths have a written form. A live path is `<acctHash>/<name>/<name>`: it starts at an account and follows names as they are now. A pinned path adds heads, `<acctHash>@<heads>/<idhash>@<heads>/<name>`, where each `<idhash>@<heads>` step enters one document at those heads. A share link starts at `automerge:<documentId>@<heads>` instead of an account. `parsePath` reads all three into a root and segments and throws `PathSyntaxError` on a path it can't read; `livePath` and `docStep` write them. `idhash(documentId)` is the first 12 bytes of SHA-256 over the id in base58, so a document id stays out of the URL. `formatHeads` and `parseHeads` sort heads, so one set of heads is one string. All are exported from `@inkandswitch/patchwork-filesystem`, which now depends on `bs58`. Nothing resolves these paths yet.
