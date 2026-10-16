---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork": patch
---

A tab no longer keeps every package's doc in memory just to hear when a package changes. The ModuleWatcher used to hold each package's folder or directory doc in the tab's Repo for the life of the page, only to listen for new heads. It now finds a package's latest version by asking the service worker for its url without heads, which the automerge worker redirects to the url at the doc's latest heads (letting go of the doc 5s later, as it does for every request). It hears about new versions from the sync node, which keeps the doc subscribed with the server and says when something arrives for it, without the tab loading it.

The sync node takes `watch`/`unwatch` for a sedimentree and answers `changed`, with no data, whenever it gets something for it from the server or from a tab's write, the writing tab's watchers included. A watch subscribes the doc with the server if the node hasn't since it started, and again after the connection drops. `PortSyncRemote` gets `watch(sid, onChange)`, which sends its watches again after a worker restart and calls every watcher once, since the doc may have moved while there was no node. `@inkandswitch/patchwork-bootloader` exports this as `watchDocument(url, onChange)`, which returns the function that stops it, and `getSedimentreeId(url)` for the sedimentree id of a document.

`@inkandswitch/patchwork-filesystem` adds `PackageTracker`, how a ModuleWatcher finds a package's latest version (`findLatest`) and hears there may be a newer one (`watch`), as a new last argument to the `ModuleWatcher` constructor. The default, `trackPackagesInRepo(repo)`, holds the package docs in the Repo as before. `trackPackagesViaServiceWorker(watch)` is the browser one, and patchwork's `setup()` now passes it with `watchDocument`. `fetchLatestViaServiceWorker` and `getDefaultBranch` are exported too.

A deprecated branches doc in the module settings is now followed to its default branch by the automerge worker, on any url without heads, rather than by the tab.
