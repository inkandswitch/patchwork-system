---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork": patch
---

Package management is whatever is bound at `/packages` in the account's namespace. New accounts bind `/` to their root folder and `/packages` to a new Packages folder; an older account gets a Packages folder at boot, linking each automerge package its module-settings doc lists, by its `package.json` name. The ModuleWatcher loads every package in the `/packages` union (`addPackagesFolder`, `watchPackagesFolder`), keyed by document so a rename reloads nothing, and looks each one up as a pinned `/@/` URL (`trackPackagesFolder`) that it imports and the service worker checks against the package's file list. A package's list now covers everything under it, nested folders included, and a redirect to a folder carries the folder's whole list. New accounts, and migrated ones, also get a `packages` link in their root folder to that folder, so `/packages` shows in the tree like any other folder. The ModuleWatcher reports each package's status (`packageStatus(url)`: loading, loaded with its plugins, or failed with why) and fires a `"status"` event when one changes; it is now an `EventTarget`. `AccountDoc.moduleSettingsUrl` is deprecated in favour of the `/packages` binding; it's still read, deduplicated against `/packages`, since the Packages UI installs into it.
