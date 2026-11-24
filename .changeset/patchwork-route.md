---
"@inkandswitch/patchwork": patch
---

A site can say where it is some other way than the hash. The router reads and writes the address only through `window.patchworkRoute` when a site has put one there before `setup()`: `params()` gives the params a hash would have (`doc`, `tool`, `frame`, …), and `go(params)` moves there; the router only calls `go` when the params differ from where the route already is. The site still announces a move with a `hashchange` on `window`. With no `patchworkRoute` the router uses `location.hash` exactly as before. Older link shapes (a bare `automerge:` url, a big-patchwork slug) are still rewritten from the hash. The `PatchworkRoute` type is exported from `@inkandswitch/patchwork`.
