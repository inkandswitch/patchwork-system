---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-elements": patch
---

`patchwork:open-document` takes an optional `path`: where the document was opened from, like a cwd. It is shaped like a service-worker path, `/<encoded automerge URL>/<subpath>/` (e.g. `/automerge%3A<rootFolderId>/src/`). Pass it via `openDocument(element, url, toolId, path)` or `patchwork.open(url, { path })`; it travels on the event detail only and is not written to the hash.

`<patchwork-view>` has a matching `path` attribute and property, so a frame can hand the opened tool its cwd. Changing it does not remount the tool.
