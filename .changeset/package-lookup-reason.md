---
"@inkandswitch/patchwork-filesystem": patch
---

When the service worker can't redirect a package url to its heads, the error now includes the automerge worker's reason (the first line of its 557 body — e.g. the doc is unavailable, or the resolve timed out) instead of only the status.
