---
"@inkandswitch/patchwork-filesystem": patch
---

The ModuleWatcher says how each package is doing. `packageStatus(urlOrDocumentId)` answers `{ state: "loading" }`, `{ state: "loaded", plugins }` with the ids of the plugins the package brought, or `{ state: "failed", error }` with the message of the lookup or import that failed, and undefined for anything that isn't a package doc it loads. The watcher is now an `EventTarget` and dispatches `"status"` whenever one changes. `PackageStatus` is exported.
