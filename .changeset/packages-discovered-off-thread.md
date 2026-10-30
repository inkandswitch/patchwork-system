---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

`/packages` packages are discovered off the main thread, like module-settings packages. The pinned `/@/` URL a `/packages` lookup answers with now goes through the ModuleWatcher's `importAutomergePackage` hook, so the browser's module-loader worker reads its plugin descriptors, and a plugin's `load()` re-imports the same pinned URL on the main thread. Before, those packages' entry points were imported on the main thread to register them.

`importPluginFromPackage(url, type, id)` takes a folder doc pinned to heads or a pinned `/@/` URL. `importPluginFromFolderDocUrl` is kept as a deprecated alias for it.
