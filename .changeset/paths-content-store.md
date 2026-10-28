---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

The service worker serves `/@/` paths. A live path (`/@/<acctHash>/Projects/foo/x.js`) redirects to its pinned form. A pinned one names its folder's file list by hash (`…/<idhash>@<heads>~<listHash>/x.js`): the list records each file's content hash and the heads it was read at, so the service worker checks the list against the URL and the bytes against the list, and serves a pinned URL's old bytes even after the file changes. Lists and bytes are kept in a content-addressed store (`patchwork-content-<acctHash>`) that anything on the origin can write and that is checked on every read. Links no longer need heads to pin what they point at, and no document id appears in a URL or in the store. Resolvers no longer write the cache: they hand bytes back and the service worker decides what to keep, so legacy `/automerge%3A…` URLs are now cached by the service worker itself. New in `@inkandswitch/patchwork-bootloader`: `registerAccount` (patchwork calls it at boot) and `clearAccountStore`. New in `@inkandswitch/patchwork-filesystem`: `buildFileList`, `canonicalJson`, `parseFileList`, `contentHash`, `toBytes`, `readPath` (optionally at given heads), `listFiles`, `readNode`, `WalkOptions.find`, `WalkEnd.container` and `WalkEnd.tail`. The e2e suite gains a test that a forged store entry is never served.
