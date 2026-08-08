---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork": patch
---

Create new datatype documents through a worker so package imports and datatype initialization stay off the main thread, and pass the site's import map through to worker-side package loading.
