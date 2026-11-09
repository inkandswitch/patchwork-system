---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
---

Changes made in a patchwork tab now say which package version made them. Each change's message carries `pw:<key>` (after the caller's own message, if it gave one), and the first change a package version makes to a doc is followed by one that records the key under `@patchwork.writers`, creating `@patchwork` when the doc has none. `explain(handle)` and `explainSummary(handle)` read it back, and `setup()`'s result has both, taking a url or a handle. `@inkandswitch/patchwork-plugins` exports `pluginImportUrls()`.
