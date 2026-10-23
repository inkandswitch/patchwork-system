---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

Package heads lookups no longer pile up on a busy automerge worker. A package doc that's still syncing, as everything is on a fresh login, reports a change with every batch that arrives. The `ModuleWatcher` started a lookup for each one, and the automerge worker ran each as a full resolve with its own 30-second timeout. A worker slowed by the login sync then timed them all out, and each logged its own 557.

The `ModuleWatcher` now runs one change-triggered lookup per package at a time. Changes that land while one is in flight collapse into a single lookup after it. The automerge worker shares one resolve between concurrent requests for the same package url without heads, so tabs asking at once wait on the same lookup.
