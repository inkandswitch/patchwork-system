---
"@inkandswitch/patchwork": patch
---

Serve the `/packages/…` builtin URLs in dev. Import maps don't apply to worker
scripts, so code that starts one — `@automerge/automerge-repo`'s shared
subduction websocket worker, for instance — asks for the `/packages/…` path the
build emits. Nothing served those in dev, and the worker failed to fetch; the
dev server now redirects them to the same optimized dep the page's import map
points at.
