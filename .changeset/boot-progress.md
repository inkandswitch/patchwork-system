---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
---

`setup()` takes an `onProgress` callback for a loading screen. It's told the boot stage (`workers`, `identity`, `package-list`, `packages`, `opening`), how far the public reader has got (whether this is a first visit, which has every keyhive event on the server to catch up on, and how many it has relayed), and how many of the listed packages have loaded. The bootloader exports `onPublicReaderStatus` for the reader's part on its own, and a `ModuleWatcher` reports the modules on its settings lists to `onModules`.
