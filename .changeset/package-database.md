---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork": minor
---

Filesystem has a package database, `packages`. It is saved to IndexedDB by account. `<patchwork-view>`, the router and the themes read from it.

`@inkandswitch/patchwork-filesystem` newly exports `importModule`, `pluginRecords`, `readPackageJson`, `importPackageWithJson`, and the `PackageJsonAt` and `ImportedPackage` types. `ImportedPackage.plugins` is optional. Account, `isKeyhiveDoc` and `createDocOfDatatype2` are exported from filesystem too.

`@inkandswitch/patchwork-elements` newly exports `tool`, `tools`, `toolsForType`, `defaultTool`, `onToolsChange`, `ToolView` and the themes.

`@inkandswitch/patchwork-plugins` is deprecated. It sits over the database, and now lives in `packages/plugins`.

`Patchwork.plugins` is gone. Import `packages` from `@inkandswitch/patchwork-filesystem` instead, and the tools from `@inkandswitch/patchwork-elements`.

`setup().create(type)` waits for the datatype while packages load. Once they have loaded and the datatype hasn't arrived, it rejects with `no datatype "<type>"`. Before, it threw at once.

A listed module url with no `package.json` isn't supported. It is warned about and skipped.

`@inkandswitch/patchwork` exports `bootFromLastVisit`, and `setup()` takes it. It boots from the packages of the last visit. Override it with `localStorage["patchwork:boot-from-last-visit"]` set to "on" or "off". The default is off.
