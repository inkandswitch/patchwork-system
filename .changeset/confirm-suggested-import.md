---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>` no longer imports a document's `suggestedImportUrl` on its own. When no tool supports the document but the document names a suggested import, the view says so — "No tool was found for this document, but it suggests a package at …" — and offers a "⚡ Load suggested package" button. Clicking it raises a `window.confirm` naming the URL whose JavaScript is about to run; nothing is fetched until that's accepted. When a wildcard fallback tool is already mounted, the same offer arrives as a toast instead of replacing it, dismissable with its × or Escape.
