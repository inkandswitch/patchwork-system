---
"@inkandswitch/patchwork": minor
"@inkandswitch/patchwork-bootloader": patch
---

Make `vite dev` work without a site hand-rolling the dev server.

The build emits the service worker, the automerge shared worker, the module-loader worker, and three wasm binaries. None of them existed in serve mode, so every one 404'd and dev only worked if a site served a previous production build's `dist/` behind vite. The plugin now serves all of them itself:

- The three worker entries are bundled on demand with esbuild and rebuilt per request, so they always reflect the source on disk. Their heavy imports resolve to the dev server's optimized-dep URLs, mirroring how the build rewrites them to `/packages/...` — import maps don't apply to `type: "module"` workers, so the URLs have to be real either way.
- `automerge.wasm`, `keyhive_wasm.wasm`, and `subduction.wasm` are served from the bootloader's own node_modules. `@inkandswitch/patchwork-bootloader/externals` gains `wasmAssets()`, which `emitWasmAssets` now uses too.
- `global.css` 404'd in dev: the generated `index.html` links it by bare specifier, which only the build resolves. Both patchwork's and the bootloader's stylesheets are now served under root-absolute paths, and the link points at them.
- `@patchwork/service-worker` called `emitFile` from `buildStart` unconditionally, which throws in serve mode — it logged "This plugin is likely not vite-compatible" three times on every dev-server start. It now skips emission when serving.
- Dep pre-bundling runs esbuild outside the plugin pipeline that applies `define`, so in dev the page fell back to the default storage prefix while the workers used the configured one — the two would have opened different IndexedDB databases. The defines are now passed to the optimizer as well.

Sites no longer need to filter `@patchwork/service-worker` out of the plugin list, serve stylesheets themselves, or keep a built `dist/` around for `vite dev`.
