---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-provenance": patch
---

Changes made in a patchwork tab now say which package version made them. Each change's message carries `pw:<key>` (after the caller's own message, if it gave one), and the first change a package version makes to a doc is followed by one that records the key under `@patchwork.writers`, creating `@patchwork` when the doc has none. `explain(handle)` and `explainSummary(handle)` read it back, and `setup()`'s result has both, taking a url or a handle. `@inkandswitch/patchwork-plugins` exports `pluginImportUrls()`.

The new `@inkandswitch/patchwork-provenance` package holds the reading half: `explain`, `explainSummary` and `parseMessage` (which `@inkandswitch/patchwork` re-exports), `createHistory` for reading a doc's history a little at a time, and the Writers sidebar. Every site now has Writers in its context sidebar: `setup()` registers it, and the vite plugin importmaps the package so the isolated iframe can load it. It lists each package version that wrote to the selected doc, named `name@version` from its package.json, and the doc's newest changes with who made each.
