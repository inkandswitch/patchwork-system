---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>` no longer imports a document's `suggestedImportUrl` on its own. When no tool supports the document but the document names a suggested import, the view offers it — a toast saying a tool was suggested, with a button. Clicking the button raises a `window.confirm` naming the URL whose JavaScript is about to run; declining records the refusal for that URL and falls through to the usual "no tool" error.
