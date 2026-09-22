---
"@inkandswitch/patchwork-bootloader": patch
---

The service worker no longer re-caches a passthrough response whose etag matches the copy it already holds. Every tab boot used to clone the whole bundle's responses and write them back to Cache Storage, holding a second copy of each body in the service worker's process until the write landed; with several tabs opening at once that peaked at a few hundred MB.
