---
"@inkandswitch/patchwork": patch
---

The vite plugin applies this repo's pnpm patch of `@automerge/automerge-repo` (`patches/@automerge__automerge-repo@<version>.patch`, shipped in the package as `dist/patches/`) to every copy of automerge-repo vite bundles for a site, in place of the two hand-written edits it carried before. A site installing from npm gets the same automerge-repo as this workspace: the real `detach` behind eviction, the `mesh` adapter role, and whatever else the patch holds.

Covered: the page build's chunks, including the `/packages/@automerge/automerge-repo*.js` import-map chunks that patchwork's own protocol-handler worker imports from; the dev server's pre-bundled deps (an esbuild `onLoad` plugin in `optimizeDeps`); and module workers a site builds through vite (`new Worker(new URL("./x.ts", import.meta.url), { type: "module" })`), which vite bundles in a separate rollup pass with only `worker.plugins` — the `config()` plugin's worker config now sets `worker.plugins` to `[wasm(), patches({ complete: false })]`, so those bundles are patched too. A site that passes `worker: false` and writes its own `worker.plugins` has to add `patches({ complete: false })` to them itself.

`patches()` fails the build if any file the patch edits never reached the bundler; `patches({ complete: false })` skips that check, for a worker bundle that may import none or only some of them. The patch is pinned to one automerge-repo version; a version bump fails the build until the patch is re-made against it.
