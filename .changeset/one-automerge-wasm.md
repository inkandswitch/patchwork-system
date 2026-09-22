---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-providers": patch
"@inkandswitch/edge-handles": patch
---

Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

`initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

`@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

`pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.
