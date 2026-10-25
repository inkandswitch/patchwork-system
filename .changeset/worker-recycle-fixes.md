---
"@inkandswitch/patchwork-bootloader": patch
---

Fixes to how the automerge worker recycles itself to give back wasm memory:

- The service worker no longer deletes the cache a restarting automerge worker saves what it had loaded into (`patchwork-package-memory`, now `LOADED_CACHE` in the bootloader's types). It cleared every cache but its own on each activation, so the replacement never had anything to restore.
- A worker with classic sync connected recycles like any other. Tabs ask the replacement to connect classic sync again, after a restart and after the worker goes unexpectedly, so connecting it no longer stops the worker from ever recycling.
- The recycle check counts subduction's wasm memory too, not only automerge's.
