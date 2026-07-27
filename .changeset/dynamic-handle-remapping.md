---
"@inkandswitch/patchwork-providers": minor
"@inkandswitch/patchwork-elements": patch
---

Dynamic handle remapping without remounts: `repo:handle-descriptor` is now a
streaming subscription end-to-end.

- `OverlayRepo.find`/`findWithProgress` keep their descriptor subscription
  open instead of taking only the first answer. When a remapper emits a new
  descriptor (e.g. a draft overlay re-pointing at a different clone), the live
  `OverlayHandle` is re-pointed in place via the new `swapBackingDocHandle`:
  forwarded event listeners are re-wired onto the new backing, cached
  sub-handles are recursively re-based, and a synthetic `change` event with
  `scopeReplaced: true` tells consumers to reconcile from `doc()` rather than
  apply patches (the old and new backings may be divergent forks). One-shot
  providers that answer exactly once keep working unchanged.
- `forwardingProxy` accepts a backing getter so the proxy identity consumers
  hold stays fixed while the backing changes underneath.
- `OverlayRepo` gained `dispose()`, which tears down the live descriptor
  subscriptions; `<patchwork-view>` calls it when the element disconnects
  (the overlay repo survives attribute-driven teardowns/re-syncs).
- `OverlayHandle.emit` isolates listener errors (logged, not rethrown) so one
  consumer that cannot handle an event does not starve the listeners behind
  it, and skips listeners unsubscribed during the same emit so a torn-down
  consumer is never invoked with an event it already handed off.
