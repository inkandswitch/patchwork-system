---
"@inkandswitch/patchwork-elements": patch
---

A failed doc load no longer stops retrying on its own after about 30 seconds. It keeps trying every 30 seconds for as long as the view is up, so a doc whose sender takes a few minutes to sync it still opens without a reload.
