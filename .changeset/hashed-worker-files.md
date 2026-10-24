---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-e2e": patch
---

A build emits every file the automerge worker and the page load under a content-hashed name in `/assets`, served `immutable`, instead of at a fixed path: the `/packages/…` chunks, `automerge.wasm`, `subduction.wasm`, `keyhive_wasm.wasm`, the worker's second stage (`automerge-protocol-handler.js`) and `module-loader-worker.js`. A fixed path could only be revalidated, which fails offline, or cached on a guess, which after a deploy could start the worker on one build's files and the rest of another's. Now a build only ever loads its own copies, and they start offline from the HTTP cache.

Only `service-worker.js` and the automerge worker's script, `automerge-protocol-handler-worker.js`, keep their fixed paths, since the browser starts both by URL from one build to the next. The worker's script is served `max-age=0, stale-while-revalidate=31536000`, so the browser starts it from its copy when it can't check for a newer one. Everything that copy imports is hashed, so even a copy from an older build brings up one whole build. A worker that restarts because a newer tab connected fetches its script past the cache first, so the replacement starts on the newer build rather than the cached one, which would carry on serving the newer tab.

The fixed paths still work: the generated `_redirects` sends each one to its hashed name with a 302, and `vite preview` does the same, whether or not the site writes Netlify files. But a module imported both by a fixed path and by its hashed name is two modules, so code should import the packages by bare specifier (the import map points at the hashed names) and load the rest by the URLs in `@inkandswitch/patchwork-bootloader/emitted`: `AUTOMERGE_WASM`, `SUBDUCTION_WASM`, `KEYHIVE_WASM`, `AUTOMERGE_PROTOCOL_HANDLER` and `MODULE_LOADER_WORKER`. In dev these are the fixed paths.

API changes:

- `emitWasmAssets` (`@inkandswitch/patchwork-bootloader/externals`) emits the wasm under hashed names and returns each one's reference id by file name.
- `@inkandswitch/patchwork/vite` has a `hashed()` plugin, included in `patchwork()`, which swaps in the hashed names. `hashedFiles(config)` gives a build's table of them, also exported from `@inkandswitch/patchwork/vite/hashed`.
- `workers` entries say whether a worker is `hashed`. The workers no longer import the packages from `/packages/…` URLs: they link to the build's chunks like the page does.
- `buildHeaders(options, hashed?)` takes that table for the wasm preloads.
- The new `buildRedirects(hashed?)` writes the redirects. `REVALIDATED_PATHS` and `REVALIDATED_CACHE_CONTROL` name the stale-while-revalidate files and their header.

The e2e offline test waits for the wasm by the URLs the page preloads.
