# @inkandswitch/edge-handles

## 0.1.4

### Patch Changes

- 1d22480: Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

  The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

  `initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

  `@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

  `pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.

## 0.1.3

### Patch Changes

- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

## 0.1.2

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.1.1

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.1.0

### Minor Changes

- aaf788c: update edge handles to use subdoc handles
