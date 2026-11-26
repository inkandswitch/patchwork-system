---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-elements": minor
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork": minor
---

`@inkandswitch/patchwork-filesystem` has a package database, `packages`. It is saved to IndexedDB by account, and only the packages a package list added are saved. `<patchwork-view>`, the router and the themes read from it.

`packages.open(name, { hydrate: false })` saves from then on, but loads nothing from last visit.

`@inkandswitch/patchwork-filesystem` newly exports `importModule`, `pluginRecords`, `readPackageJson`, `importPackageWithJson`, and the `PackageJsonAt` and `ImportedPackage` types. `ImportedPackage.plugins` is optional. Account, `isKeyhiveDoc` and `createDocOfDatatype2` are exported from filesystem too.

`ModuleWatcher` gains `database`, `forgetUnlisted()` and `recheck()`. Its `importAutomergePackage` is typed `ImportedPackage`.

`@inkandswitch/patchwork-bootloader`'s `importAutomergePackageViaWorker` returns an `ImportedPackage`, with its `package`.

`@inkandswitch/patchwork-elements` newly exports `tool`, `tools`, `toolsForType`, `defaultTool`, `onToolsChange`, `ToolElement`, `ToolRender`, `ToolView` and the themes.

`ComponentDescription`, `LoadedComponent` and `Component` no longer extend `PluginDescription`. They have no `importUrl` or `icon`.

`@inkandswitch/patchwork-plugins` is deprecated. It sits over the database, and now lives in `packages/plugins`. `registerPlugins` and `getRegistry` still work. It has a new peer dependency on `@inkandswitch/patchwork-elements`.

`Patchwork.plugins` and the `PluginsApi` type are gone. Import `packages` from `@inkandswitch/patchwork-filesystem` instead, and the tools from `@inkandswitch/patchwork-elements`.

`setup().create(type)` waits for the datatype while packages load. Once they have loaded and the datatype hasn't arrived, it rejects with `no datatype "<type>"`. Before, it threw at once.

A listed module url with no `package.json` isn't supported. It is warned about and skipped.

`@inkandswitch/patchwork` exports `bootFromLastVisit`, and `bootFromLastVisit` is a `setup()` option. It boots from the packages of the last visit. Override it with `localStorage["patchwork:boot-from-last-visit"]` set to `"on"` or `"off"`. The default is on. When it's off, last visit's packages aren't read back at all.
