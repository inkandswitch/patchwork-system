---
"@inkandswitch/patchwork-providers-solid": patch
"@inkandswitch/patchwork-providers": patch
---

Depend on `solid-automerge` instead of `@automerge/automerge-repo-solid-primitives`. The Solid bindings are published under the new name; the peer dependency of `@inkandswitch/patchwork-providers-solid` moves to `solid-automerge` (`^2.0.1`). Install `solid-automerge` in place of `@automerge/automerge-repo-solid-primitives` — the exported API (`useDocument`, `createDocumentProjection`, `autoproduce`, …) is unchanged.
