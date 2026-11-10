---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-provenance": patch
---

Changes made in a patchwork tab now say which package version made them. Each change's message carries `pw:<key>` (after the caller's own message, if it gave one), and the first change a package version makes to a doc is followed by one that records the key under `@patchwork.writers`, creating `@patchwork` when the doc has none. `explain(handle)` and `explainSummary(handle)` read it back, and `setup()`'s result has both, taking a url or a handle. `@inkandswitch/patchwork-plugins` exports `pluginImportUrls()`.

The new `@inkandswitch/patchwork-provenance` package holds the reading half: `explain`, `explainSummary` and `parseMessage` (which `@inkandswitch/patchwork` re-exports), `createHistory` for reading a doc's history a little at a time, and the Writers sidebar. Every site now has Writers in its context sidebar: `setup()` registers it, and the vite plugin importmaps the package so the isolated iframe can load it. It shows the selected doc's history as a timeline of sessions coloured by the tool that made them, lets you narrow it to one tool or one person, and opens each session to show what every change did (each path, before and after), where in the tool's source it came from (mapped through the tool's source maps), and a button to open the doc as it was after that change.

The `pw:` line now also says where in the package a change was made (`pw:<key> dist/index.js:412:17`). Each change's automerge author is the first 8 bytes of the device's key, and the doc records that device's full key and the account's contact card under `@patchwork.authors`. That's what the tab says about itself, not signed. `explain` returns `at`, `author`, `person` and `deps` for each change.
