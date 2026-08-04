---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>` no longer imports a document's `suggestedImportUrl` on its own. When no tool supports the document but the document names a suggested import, the view asks first with a `window.confirm` naming the URL whose JavaScript is about to run. Declining records the refusal for that URL and falls through to the usual "no tool" error.
