---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

`importPluginFromPackage` replaces `importPluginFromFolderDocUrl`. It takes any package url `importPackage` does, an automerge folder doc or an http url, where the old one took only a folder doc. `importPluginFromFolderDocUrl` stays as a deprecated alias. The module-loader worker and `importAutomergePackageViaWorker` take the same urls, and the ModuleWatcher's default import goes through `importPackage`.
