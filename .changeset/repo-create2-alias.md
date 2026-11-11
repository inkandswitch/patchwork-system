---
"@inkandswitch/patchwork": patch
---

`setup()` puts `create2` back on the Repo class as an alias of `create()`, so published tools that still call automerge-repo 2's `repo.create2()` keep working on automerge-repo 3. Overlay repos and the scratch repo get it too. New code should use `await repo.create()`.
