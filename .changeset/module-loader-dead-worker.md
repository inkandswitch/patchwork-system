---
"@inkandswitch/patchwork-bootloader": patch
---

The module-loader worker is replaced when it errors. It used to be kept after an `error`, so later package discoveries went to a dead worker and never answered. Now an error fails the requests that were waiting on it and the next request starts a fresh worker; a request that hasn't been answered in 60s fails on its own.
