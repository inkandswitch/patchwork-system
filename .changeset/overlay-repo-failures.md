---
"@inkandswitch/patchwork-providers": patch
---

`OverlayRepo.findWithProgress` reports failure the way the realm-local repo does. It used to say `loading` forever once a resolution failed. Now `peek()` and subscribers see `unavailable` (the document isn't there yet) or `failed` with its `error`, and a later retry moves them back through `loading` to `ready`. As in the repo, `subscribe` reports transitions only. `dispose()` now rejects every `find` still pending, with "OverlayRepo disposed", instead of leaving it unsettled.
