---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Restart the automerge shared worker, and offer stale tabs a reload, after a deploy.

A SharedWorker is keyed by url and name, so a tab opened after a deploy used to attach to whichever instance the older tabs were keeping alive: a new page on an old worker, sharing IndexedDB with it. The vite plugin now compiles a `__BUILD_ID__` define (`Date.now()` at build time, or the new `buildId` option) into both the page and the worker. Every tab sends its build id when it connects, and a worker that hears from a newer build announces it is restarting, finishes the handoffs it has in flight, flushes its repo, and closes itself; the tabs respawn it on the new script. The service worker re-broadcasts any handoff that got caught in between.

The service worker now carries the build id too, so every deploy installs a new one instead of only deploys that touched its code. When it takes control of an open tab, the tab asks it which build it is. A tab older than that build, or older than the one that triggered a worker restart, pops up a small box saying there's an updated patchwork system core, with a button to reload; it doesn't reload on its own, so nobody loses their place mid-edit. `setupServiceWorker({ onNewBuild })` replaces that with your own handling, say `() => location.reload()`. `restartAutomergeProtocolHandlerWorker()` is on `window` as a dev escape hatch, next to `bumpServiceWorkerCache()`.

Builds with a lower id than the running worker are left alone, so a rollback is a rebuild, not a republish of an old build.
