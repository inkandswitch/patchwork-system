---
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork": patch
---

`patchwork:open-document` can name the package to take its tool from. `OpenDocumentEventDetail` has a `packageUrl`, `openDocument()` takes it as a third argument, and `patchwork.open()` takes it as `package`. When several packages bring one tool id, this is how something asks for a particular package's copy. A frame passes it on to `<patchwork-view package-url>`. The router keeps it in the hash as `package=`, so a link opens the same copy.
