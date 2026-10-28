---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

The service worker serves `/@/` paths. A live path (`/@/<acctHash>/Projects/foo/x.js`) redirects to its pinned form. A pinned one is served from a content-addressed store (`patchwork-content-<acctHash>`) whose every read is hashed and checked against an index that only the automerge worker fills, over `fetch()` requests the service worker checks are really from it. Resolvers no longer write the cache: they hand bytes back and the service worker decides what to keep, so legacy `/automerge%3A…` URLs are now cached by the service worker itself. New in `@inkandswitch/patchwork-bootloader`: `registerAccount` (patchwork calls it at boot) and `clearAccountStore`. New in `@inkandswitch/patchwork-filesystem`: `readPath`, `listFiles`, `readNode`, `WalkOptions.find` and `WalkEnd.container`. The e2e suite gains tests that a forged store entry is never served and a page can't answer for the automerge worker.
