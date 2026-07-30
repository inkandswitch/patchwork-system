---
"@inkandswitch/patchwork-bootloader": minor
"@inkandswitch/patchwork": minor
---

Namespace IndexedDB and peer ids with a new build-time `storagePrefix` option.

The tab and the shared automerge worker are separate bundles that must open the same databases. Both now read the name from one place, `@inkandswitch/patchwork-bootloader/storage`, resolved from the `__STORAGE_PREFIX__` define the vite plugin emits unconditionally.

Previously each side resolved `__SITE_NAME__` itself with a different fallback — `"patchwork.inkandswitch.com"` in the worker, `"patchwork"` in the tab — so a site that never set `siteName` had its tab and worker on two different keyhive databases, and one that passed `setup({name})` split them the same way, since a runtime option never reaches the worker.

- `storagePrefix` defaults to `"patchwork"` and is settable only in the build config. Sites sharing an origin must use distinct prefixes. It is deliberately not derived from any display name: changing it points a site at empty storage, so a rebrand must not be able to change it by accident.
- Sites that relied on `siteName` to namespace their storage must now set `storagePrefix` explicitly to that same value to keep their existing databases.
- `createRepo` in `@inkandswitch/patchwork` no longer takes a site name argument.
