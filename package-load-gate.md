# Package load gate

Status: planned, not implemented.

Patchwork runs code from packages: their entry points when they're imported, and their plugins' functions after that (`init`, `getTitle`, tool and component render functions). Today nothing checks a package before it runs, except the `window.confirm` in front of a suggested import. This is the plan for checking packages before their code runs, and what that check does not cover.

## Where user code enters

- `importModule` in `core/filesystem/src/packages.ts` is the `import()` that everything goes through. It's called by `importPackageFromFolderDocUrl`, `importPackageFromHttpUrl` and `importPackage`. `importPluginFromFolderDocUrl` also runs a plugin's `load()` or `import(plugin.import)`.
- `PluginRegistry.load` in `core/plugins/src/registry/registry.ts` runs `description.load()` or `import(description.import)`.
- `ModuleWatcher` in `core/filesystem/src/module-watcher.ts` imports every package listed in the module settings, with no prompt, and imports it again whenever the package doc changes.
- The module-loader worker (`core/bootloader/src/module-loader-worker.ts`) imports each package's entry point to discover its plugins. The package's top-level code runs there first, and runs again on the main thread when a plugin is loaded (`core/bootloader/src/module-loader.ts`).
- `#loadSuggestedImport` / `#importSuggestedModule` in `core/elements/src/legacy-impl.ts` import a doc's `suggestedImportUrl` after a `window.confirm`.
- Plugin code is called at `createDocOfDatatype2` (`init`, `core/plugins/src/datatypes.ts`), the router (`getTitle`, `core/patchwork/src/router.ts`), tool render (`core/elements/src/legacy-impl.ts`) and component render (`core/elements/src/patchwork-view.ts`).
- Files from documents are served by the automerge SharedWorker's resolver (`core/bootloader/src/resolver.ts`), reached through the service worker's `/automerge%3A…` URLs (`core/bootloader/src/service-worker.ts`).

## Decisions

**Check whole packages.** The unit is a package root doc at specific heads, which is the first path segment of every module URL (`/automerge%3A<root>%23<heads>/…`). Relative imports inside a package keep that segment, so one check covers the whole package.

**Not in the plugin registry.** By the time `registerPlugins` is called, the entry point has already been imported, by the module-loader worker's discovery pass or by `#importSuggestedModule`. A check in the registry would only stop plugin implementations, not the package's top-level code.

**An `onBeforeLoad` hook inside `importPackage*`.** It's set through a module-level setter in `@inkandswitch/patchwork-filesystem`, which `patchwork` calls during startup. Roughly:

```ts
onBeforeLoad?: (pkg: {
  url: string; // automerge url at heads, or http(s) url
  source: "settings" | "suggested" | "plugin-import" | "package";
}) => boolean | Promise<boolean>;
```

`@inkandswitch/patchwork-filesystem` is an import-map external (`core/bootloader/src/externals-list.ts`), so every package shares the same `importPackage`. That makes it the approved way for one package to import another, instead of a raw relative `import("../base/packages/…")`. The `window.confirm` in front of suggested imports becomes the default hook for the `"suggested"` source. A plugin descriptor's `import` string can point outside its own package, so `registry.load` either runs the hook on that URL or requires it to stay inside the package that registered it.

The hook can't really know who is asking. A package can pass its `import.meta.url`, but same-origin code can lie about it, so the policy should treat that as a hint and not rely on it.

**The resolver enforces approvals.** Before calling `import()`, `importPackage` tells the resolver that this package at these heads is approved, and waits for the resolver to acknowledge it. The resolver refuses `script`, `worker` and `sharedworker` requests under any package that hasn't been approved. That catches `../` climbs into another package, which land on a different package and get checked on their own.

- A refused request returns `abort`, which becomes a network error. The browser remembers a failed import for that URL in that realm, so the approval has to be acknowledged before `import()` runs. Otherwise a race leaves a failure memoized for a URL that was about to be approved.
- Refuse both paths: the `cache.put` path and the inline path that serves responses which aren't pinned. Refusing only at `cache.put` would still serve unapproved code, just without storing it.
- Data requests (`package.json` and the heads lookup in `fetchLatestViaServiceWorker`) stay allowed, because the hook needs them to find the heads it's being asked about.
- Don't write anything to the cache unless it passed the check. The service worker serves cache hits without asking the resolver, so being in the cache should mean it was checked. To revoke an approval, delete the cached entries under that package, or put a policy version in `cachename`.

**Pin links when a package is published.** The heads on a URL pin only the doc it names. Links inside a folder are usually bare, so the files under a pinned root can still change, and `resolvePath` marks them `pinned: false` and they're never cached (see `Resolved.pinned` in `core/filesystem/src/resolve.ts`). Redirecting to pinned URLs doesn't fix this, because a module's identity is the URL that was requested, before the redirect, so a redirect leaves identity on the bare URL until the page reloads. Files reached by relative imports only become content-addressed if publishing writes links with heads, so that the root's heads cover everything below it.

## Known gaps

The gate keeps unchecked code out through the normal loading path. It does not contain code that's already running in the origin.

- **Forging cache entries.** Any same-origin code can call `caches.open(cachename).put(...)` and write a forged response, and the service worker serves cache hits without asking the resolver. Refusing to cache unchecked responses does not prevent this. When the gate is built, add a comment at the resolver's `cache.put` and at the service worker's cache-hit path saying so.
- **Imports that bypass packages.** Without a CSP of `script-src 'self'` (no `data:`, `blob:`, `'unsafe-eval'`, `'wasm-unsafe-eval'` or remote hosts), code can still `import()` `data:`, `blob:` and remote URLs, use `new Function`, or instantiate wasm it got with `fetch`.
- **Calling the registry directly.** `registerPlugins` and `getRegistry` are importable, so a running package can register plugins without going through the hook.
- **Revoking an approval.** `unregisterPlugins(url)` removes a package's plugins from the registry, but code that has already run stays in memory until the page reloads.
- **What the module-loader worker can do.** Discovery runs package code in a same-origin worker, which can reach IndexedDB, the Cache API and `fetch`. The main thread has to run the hook before posting `discover`.

Containing code that is already running needs a separate origin or a sandboxed iframe or worker.
