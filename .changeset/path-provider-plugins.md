---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Packages can now say what a document of their type contains. A `patchwork:path-provider` plugin is a `PathProvider` with `supportedDatatypes`. The built-in providers (account, directory, folder, branches) are always asked first and can't be overridden. After them come plugins, in registration order.

- `patchwork-filesystem`:
  - a `Child` can be `{ name, sub: [...segments] }`, a value inside the document offered as a sub-document. A walk that ends at one reports it as `WalkEnd.sub`, and `resolveLivePath` returns `handle.sub(...segments)`;
  - `PathProvider` gains the optional `add`, `rename` and `remove`, for whoever shows a provider's children to edit them;
  - walks take `WalkOptions.providers` (an `ExtraProviders`), asked after the built-ins, as do `listChildren` and `listUnion`. A provider that throws is treated as having no children.
  - extra providers apply only to a document a walk goes on through. Whether a document a path ends at is a container, and what a file list counts as a file, are the built-ins' call, so installing a provider doesn't change what an existing pinned URL means;
  - a link with path segments (to a sub-document) isn't walked or listed as the whole document.
  - a name a provider spreads over several path segments is written as the file list writes it, so every spelling of it pins to a tail the list covers.
- `patchwork-plugins`: the plugin type `PathProviderDescription`/`PathProviderPlugin`, with `pathProviderFor(doc)` (built-ins, then plugins), `packagePathProviders` (plugins only, for `WalkOptions.providers`), and `pathProviderTypes()`. `"*"` in `supportedDatatypes` is ignored.
- `patchwork-bootloader`: `createResolver` takes `providers`. A tab's resolver passes the registered plugins, and the automerge worker's passes none, since it never loads package code.
- `patchwork`: `&path=` resolves through registered path providers too, and a path that ends at a sub-document opens it at its sub-handle's URL. A `path=` that names a different part of the document `doc=` names is dropped, as one naming a different document already was.
