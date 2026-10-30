---
"@inkandswitch/patchwork-bootloader": patch
---

The service worker's tab accept timeout (250ms) moves into its own module, `handoff-timing.ts`, so the node test harness can widen it. Its in-process fake tabs share the service worker's event loop, so on a loaded machine their "accepted" could miss the window and the test would wait out a 35-second broadcast. Behaviour in browsers is unchanged.
