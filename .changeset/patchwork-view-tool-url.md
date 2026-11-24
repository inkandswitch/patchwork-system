---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>` takes a `package-url` attribute (and `packageUrl` property) alongside `doc-url` and `tool-id`: a package to take the tool from instead of the registry. The view imports the package, finds the `patchwork:tool` in its `plugins` whose id is `tool-id` (or, with no `tool-id`, its tool for the doc's type), and shows the doc with it, without registering anything. An `automerge:` url without heads is imported pinned to the package doc's heads, and the view remounts with the new version only when those heads move, loading it before taking the old one down. An `automerge:` url with heads, or an http(s) url, stays on the version it names. A package that fails to import, or lacks the tool, gets the "can't load" card.
