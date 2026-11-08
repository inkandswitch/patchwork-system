---
"@inkandswitch/patchwork": patch
---

The tab's title now follows the open document: it updates when the document is renamed, a slow lookup for a document you've already left can no longer overwrite the title of the one you're on, and the previous document's title isn't kept while the next one loads. Going Back to a hash with no document puts the site's title back, and going Back past a `frame=` link puts the home frame back. Older link shapes (`#automerge:<id>` and big-patchwork `<slug>--<id>`) are rewritten in place, so Back steps over them instead of landing on a link that rewrites itself forward again.
