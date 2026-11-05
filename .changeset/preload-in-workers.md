---
"@inkandswitch/patchwork": patch
---

Dynamic imports in chunks the automerge worker shares with the page no longer throw "document is not defined". Vite's preload helper adds `<link>` tags to preload an import's dependencies, and the worker has no `document`, so the resolver's Repo failed to start on keyhive builds and package files served through it (such as `automerge:` system packages) didn't load. The helper now skips that preloading where there's no `document`.
