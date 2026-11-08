---
"@inkandswitch/patchwork-bootloader": patch
---

A hard reload no longer hangs boot. It loads the page past a service worker that's already active, which won't activate (and claim the page) again, so setup waited forever for a `controllerchange`. Setup now asks the active worker to claim the page; if that doesn't take within 3s (a worker from a build that doesn't know `claim`), the page reloads once, normally, which the worker does control. A second failure within 30s fails boot instead of reloading again.
