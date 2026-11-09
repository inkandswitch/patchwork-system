---
"@inkandswitch/patchwork-providers": patch
---

`OverlayRepo.findWithProgress` reports failure the way the realm-local repo does. It used to say `loading` forever once a resolution failed. Now `peek()` and subscribers see `unavailable` (the document isn't there yet) or `failed` with its `error`, and a later retry moves them back through `loading` to `ready`. A subscriber that calls `find` or `whenReady()` as it hears the failure, or the retry starting, joins that retry rather than opening a second resolution beside it. As in the repo, `subscribe` reports transitions only. `dispose()` now rejects every `find` still pending, with "OverlayRepo disposed", instead of leaving it unsettled.
