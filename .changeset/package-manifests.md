---
"@inkandswitch/patchwork-packages": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
---

New package: `@inkandswitch/patchwork-packages`, which reads `patchwork.json` package manifests as data.

A package declares what it provides in a `patchwork.json` at its root:

```json
{
  "manifest": 1,
  "name": "Chat",
  "plugins": [
    {
      "id": "chat",
      "type": "patchwork:tool",
      "name": "Chat",
      "import": "./tool"
    }
  ],
  "permissions": ["repo:read"]
}
```

`readPackageManifest(url)` fetches that manifest from an Automerge folder doc or an HTTP package root and returns its plugins with `import` resolved to an absolute URL. An `import` is first offered to `package.json` `exports` as a subpath, so `"./tool"` can be aimed at a `patchwork` condition (`{"./tool": {"patchwork": "./dist/patchwork-tool.js", "import": "./dist/tool.js"}}`); anything `exports` doesn't answer for is a path relative to the package root.

`PackageWatcher` watches the packages a settings doc lists and announces each package's manifest contents, re-announcing when a folder doc changes. A source lists its packages under `modules` (an array of urls), under `packages` (a name-to-url map), or both. It imports nothing — enumerating installed tools no longer evaluates any of their code, and a plugin's implementation is only fetched when something imports its URL.

A package with no `patchwork.json` is handed to the watcher's optional `readLegacyPackage`; without it, such a package is skipped. `readLegacyPackage` from `./legacy-adapter.js` reads the package in the import sandbox, off the main thread, warns that it had to be imported to be enumerated, and gives each plugin it found a blob-URL module that imports the package and default-exports whatever that plugin's own loader resolves to. So an old-style package is announced as an ordinary manifest — every plugin has an `import` URL, and nothing downstream has to know about `plugins` arrays or `load()` closures. The whole fallback is one file, deletable when no packages need it.

`@inkandswitch/patchwork-filesystem` gains `entryPointUrl(url)`, which resolves a package URL to its entry point without importing it.

`@inkandswitch/patchwork-bootloader`'s `./module-loader` export is now `./import-sandbox`, and `./module-loader-worker` is `./import-sandbox-worker` (emitted to `/import-sandbox-worker.js` instead of `/module-loader-worker.js`). What it does is evaluate a package's code somewhere other than the page, so it may as well say so. It also gains `discoverPluginDescriptors(url)`, the worker round-trip that `importAutomergePackageViaWorker` was already doing privately.

Nothing is wired to this yet; `ModuleWatcher` still drives the boot path.
