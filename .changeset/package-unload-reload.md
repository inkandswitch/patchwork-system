---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork": patch
---

Removing a package from settings now removes its tools and datatypes. They were registered under the heads-pinned url they were loaded from and unregistered by the bare settings entry, so nothing matched until a reload. `unregisterPlugins` now removes everything from the same package at any heads, and `registerPlugins` first removes whatever an earlier version of the same package registered that the new one no longer provides (a renamed or dropped id); ids the new version still provides are replaced in place, so a mounted view reloads once.

`ModuleWatcher`'s `onUnload` is now called with `(moduleKey, importUrl)`: the settings entry, and the url the module was last loaded from. A package published as a branches doc loads from its default branch, a different document, so unregister by `importUrl`. When the default branch moves to another document, the old branch's plugins are unloaded before the new ones register.

A package whose first lookup failed (the service worker or automerge worker still booting) is now looked up again on the import retry schedule; it used to stay unloaded until the package changed twice. And a module listed as a service-worker url for a file inside a package (`…/automerge%3A<id>/path/entry.js`) now reloads that same file at the new heads; since September 2025 a reload had imported the package's root entry point instead.
