---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
---

A package can list its plugins in `package.json` under `patchwork.plugins`, keyed by plugin type and then id. Each entry's `export` names a subpath in `exports`. When a package has this field, importing it no longer runs its main entry point. The returned `{ plugins }` comes from `package.json`, and each plugin's `load()` imports only its own export, resolved with the same conditions as before (`patchwork`, `browser`, `import`). It returns that module's default export, or the whole module if there's no default. A plugin with no `export` is still listed, and its `load()` throws. `pluginsFromManifest`, `hasPluginManifest` and `readPluginManifest` are exported for reading the field directly.

The bootloader reads the manifest on the main thread, since that runs none of the package's code. Its module-loader worker is used only for packages without one.

```json
{
  "exports": {
    "./tools/whatever": { "patchwork": "./dist/whatever.js" }
  },
  "patchwork": {
    "plugins": {
      "patchwork:tool": {
        "some-id": {
          "name": "hehe",
          "supportedDatatypes": ["a", "b"],
          "export": "./tools/whatever"
        }
      }
    }
  }
}
```
