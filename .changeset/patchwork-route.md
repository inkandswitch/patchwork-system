---
"@inkandswitch/patchwork": patch
---

A site can say where it is some other way than the hash by passing a `PatchworkRoute` as the `routing` option to `setup()`. Its `params()` gives the params a hash would have (`doc`, `tool`, `frame`, …), and `go(params)` moves there; the router only calls `go` when the params differ from where the route already is, treating a bare document ID and its full URL as the same document. The site still announces a move with a `hashchange` on `window`. By default the router uses `location.hash` exactly as before. Older link shapes (a bare `automerge:` url, a big-patchwork slug) are still rewritten from the hash. The `PatchworkRoute` type is exported from `@inkandswitch/patchwork`.
