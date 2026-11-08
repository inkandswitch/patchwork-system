---
"@inkandswitch/patchwork-elements": patch
---

A component-mode `<patchwork-view>` whose document is `unavailable` or `failed` now tries again on a timer, as legacy mode does, instead of staying blank until a reload: it resyncs and restarts after 1s, 2s, 4s, 8s, 15s and then every 30s, and a `ready` arriving first restarts it at once. The schedule and resync step are shared with legacy mode.
