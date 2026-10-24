---
"@inkandswitch/patchwork-bootloader": patch
---

The automerge worker's resolver Repo is on `self.repo` again from the moment the worker starts, for the console. The Repo is only built once something has to be resolved, so until then reading `self.repo` starts building it and gives its promise. `await repo` works either way.
