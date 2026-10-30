---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>` opens part of a document (`automerge:<id>/<path>`, a sub-handle) that has no `@patchwork` type of its own in the tool for the document it's part of, and hands that tool the sub-handle. Before, such a part, like a tldraw shape opened from the sidebar, failed with "missing @patchwork metadata".
