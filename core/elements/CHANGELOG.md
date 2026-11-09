# @inkandswitch/patchwork-elements

## 6.2.1

### Patch Changes

- 594d83b: A component-mode `<patchwork-view>` whose document is `unavailable` or `failed` now tries again on a timer, as legacy mode does, instead of staying blank until a reload: it resyncs and restarts after 1s, 2s, 4s, 8s, 15s and then every 30s, and a `ready` arriving first restarts it at once. The schedule and resync step are shared with legacy mode.

## 6.2.0

### Minor Changes

- 65f27be: A doc made public ("anyone with the link") opens for someone it isn't shared with. On ARK 0.8 a public doc is granted to patchwork's public reader, not to whoever opens it, and their own keyhive never hears of it (the server only sends an identity the ops that concern it), so patchwork-view's access gate held it back and the pane stayed blank. The gate now asks the public reader, whose fetcher is one of every public doc's members, whether it can read the doc, and checks again each time the reader has read more of keyhive, so a doc made public after it was opened opens too. `setPublicAccess` and `publicAccessChanged` in patchwork-elements (and `hasActiveAccess`, the gate's own check, for anything that wants to say why a view is empty), and `publicReaderCanRead` in the bootloader, are how setup wires that up.

## 6.1.0

### Minor Changes

- d018e31: `<patchwork-view>` no longer mounts a tool or component after it has been removed. Before this change, a `tool-id` or `url` change, a hot reload or a keyhive access change that finished after a disconnect could start the view again on the detached element, and nothing ever tore it down. The leftover tool held a disposed handle, and its registry and keyhive listeners stayed registered forever. A keyed reorder could leave two copies mounted. Attributes set on a detached element no longer mount it either; it mounts on insertion. A render queued just before a teardown no longer lands during that teardown, which used to drop the tool's cleanup.

  A failed suggested-package import now replaces the loading pulse with the error and offers to try again. Before, the error appeared next to a pulse that never stopped, and the package was never offered again.

  When a doc fails to load, a keyhive op now retries the load in place. Before, it tore down the view and rebuilt it, so a busy connection kept blanking the error. A failed load is also tried again on a timer, after 1, 2, 4, 8 and 15 seconds: the op that grants access can land before the doc can be fetched and be the last op for a while, which left a doc someone had just shared showing "unavailable" until a reload. The `#clearDocCache` step that ran before each retry is gone: it could never find the handle it was looking for. In `@inkandswitch/patchwork-providers`, `OverlayRepo` now releases the `repo:handle-descriptor` subscription of a failed resolution. It used to leak one per retry, out of reach of `dispose`.

  Keyhive access is now watched with one `ingest-remote` listener per hive instead of one per view. A burst of ops is checked once per doc, however many views show that doc. Views of legacy (non-keyhive) docs no longer listen at all.

  The "load this package?" prompt now shows the parsed URL and the host it comes from. Before, it showed the raw string the document supplied, so a document could pad it with line breaks and fake reassurance. An `automerge:` suggestion that contains whitespace or invisible characters isn't offered.

  `@automerge/automerge-repo-keyhive` is now listed as an optional peer dependency. The published types reference it through the `hive` option.

  The `<patchwork-view>` JSX intrinsic has moved out of the main entry point. Before, importing the package added both the React and Solid typings, which broke type-checking for consumers without one of them installed (unless `skipLibCheck` was on). Opt in to the one you use:

  ```ts
  import type {} from "@inkandswitch/patchwork-elements/react";
  // or
  import type {} from "@inkandswitch/patchwork-elements/solid";
  ```

  The attribute type itself is exported from the main entry as `PatchworkViewAttrs`.

### Patch Changes

- bbd12d2: Recheck access after a revocation interrupts a pending document retry.
- a50027d: Queue a keyhive retry received during a document lookup so a later sync event isn't lost.
- f564435: A failed doc load no longer stops retrying on its own after about 30 seconds. It keeps trying every 30 seconds for as long as the view is up, so a doc whose sender takes a few minutes to sync it still opens without a reload.
- 0e9f082: A timed retry of a failed doc load now asks the sync server for the doc again. Before, the retry called `find` on a query that had already settled on "unavailable", which answers from that verdict without asking anyone, so a doc that reached the server after the first look stayed unavailable until a keyhive op, a reconnect or a reload. The view now calls `repo.resyncSubduction` when it schedules each retry, where the repo has one.

## 6.0.5

### Patch Changes

- e70d1b7: A keyhive build can be made against the previous keyhive stack, for sync servers that haven't moved to ARK 0.8. `keyhive: { ark: "0.6" | "0.8" }` picks it. When it's left out, a build whose `syncServers.subduction` is on subduction.sync.inkandswitch.com gets `"0.6"`, since that server still runs it, and any other server gets `"0.8"`. So `keyhive: true` works against prod again, and pointing `syncServers.subduction` at staging.subduction.sync.inkandswitch.com gets 0.8.

  `"0.6"` swaps in the whole stack the old ARK was built with: `@automerge/automerge-repo-keyhive` 0.6.0-alpha.1, `@keyhive/keyhive` 0.3.0-alpha.1, `@automerge/automerge-repo` and its adapters and `@automerge/vanillajs` 2.6.0-subduction.48, and `@automerge/automerge-subduction` 0.16.1. These come from the new `@inkandswitch/patchwork-ark-0.6` package, which `@inkandswitch/patchwork` depends on, so a site doesn't install anything. The vite plugin aliases every import of those packages to that copy, in the build, the dev server's pre-bundling and the workers alike, and emits the matching keyhive and subduction wasm. Automerge itself stays at the current version. Builds without keyhive, and keyhive builds on `"0.8"`, are unchanged.

  On 0.6 the build reaches the server by the name ARK 0.6 ships for it rather than fetching its contact card, and keeps keyhive state in the `<prefix>-keyhive-0.6` database it used before the move to 0.8. Existing installs on prod get their old keyhive state back.

  `@inkandswitch/patchwork-bootloader`: new `keyhiveSyncServer(syncServer, storage)` and `ArkVersion` from `/keyhive-sync-server`, which pick the `syncServer` to hand `initializeAutomergeRepoKeyhive` for either ARK. `keyhiveStorageVersion` follows the build's ARK. `wasmAssets()` and `emitWasmAssets()` take an optional file to resolve keyhive's and subduction's binaries from.

  `@inkandswitch/patchwork`: the vite plugin also exports `ark`, `arkAliases` and `arkStack`, and the `ArkVersion` type. The source patch for automerge-repo is now chosen by the version being bundled, and `dist/patches` carries one for 2.6.0-subduction.48 as well as 2.6.0-subduction.49.

  `@inkandswitch/patchwork-elements`: the keyhive access gates use ARK 0.6's `bestAccessForDoc` when it's there, so public documents open again on 0.6. On 0.8 they use `accessForDoc` as before.

## 6.0.4

### Patch Changes

- 1684121: Move to `@automerge/automerge-repo-keyhive` 0.8.0-alpha.1 and `@keyhive/keyhive` 0.6.0. The other exact pins move with them so the consumer's tree keeps a single copy of automerge-repo: `@automerge/automerge-repo` and its adapters, `@automerge/react` and `@automerge/vanillajs` to 2.6.0-subduction.49, and `@automerge/automerge-subduction` to 0.20.1. The shipped automerge-repo patch makes the same changes as before, rebased onto 2.6.0-subduction.49. A site applying the patch from `@inkandswitch/patchwork/dist/patches` should take the new one.

  ARK no longer ships named sync servers, so a keyhive build finds its server's identity at startup. The tab and the automerge protocol handler worker fetch the server's contact card from `/keyhive/contact-card` on the `syncServers.subduction` host, and keep the last card fetched so a start without a network can use it. The server has to serve that endpoint. `keyhive.syncServer` and the `PatchworkKeyhiveSyncServer` type are gone; point `syncServers.subduction` at the server instead. `keyhive: true` and `keyhive: { useIdFactory }` are unchanged.

  New in `@inkandswitch/patchwork-bootloader`: `loadSyncServerIdentity(url, storage)` from `@inkandswitch/patchwork-bootloader/keyhive-sync-server`, for a site that builds its own keyhive Repo.

  The new keyhive can't read state written by 0.3, so keyhive state moves to a new `<prefix>-keyhive-0.8` database and the old one is left untouched. Existing installs start with fresh keyhive state on upgrade.

  The keyhive access gates in `patchwork-elements` use ARK's `accessForDoc`, which replaces `bestAccessForDoc`. ARK no longer has public access, so a document opens only for its members.

## 6.0.3

### Patch Changes

- 32ed577: `@automerge/automerge-repo-keyhive` is loaded only where keyhive is in use: `createRepo` and the automerge protocol handler worker `import()` it inside their keyhive branch, and `patchwork-elements` and `patchwork-plugins` no longer import it at runtime. Its entry module carries the keyhive wasm as a 3 MB base64 string, so the static imports put a 3.1 MB chunk in every tab's modulepreload list and in the worker whether or not the site enabled keyhive, at 7 to 10 MB of memory per tab, and 8 MB in the protocol-handler worker. The chunk is still emitted under `/packages/` and listed in the import map for tool code. Type imports are unchanged.

  `isKeyhiveDoc` in `patchwork-plugins`, and the keyhive access gates in `patchwork-elements`, decide from the document id's bytes: an id shorter than 32 bytes, or one whose bytes 16 through 31 are all zero, is a legacy document. They used to construct a keyhive `DocumentId` and take a throw as legacy, but that constructor is an ed25519 point decode and accepts about half of legacy padded ids, so about half of legacy documents went through `bestAccessForDoc`. This is the check behind ARK's `isUnprotectedDoc`, which it recommends over the deprecated `docIdFromAutomergeUrl`.

  When keyhive access to a document changes, `patchwork-elements` looks up the document's handle by its automerge document id before retrying. It used the keyhive `DocumentId` string, which is hex and never matched a handle, so an unavailable handle was never dropped before the retry.

  The vite plugin gives the worker chunks an empty module-preload dependency list. Vite wraps a dynamic import in a preload helper that touches `document` when it has dependencies to preload, and a worker has no `document`.

- 1d22480: Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

  The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

  `initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

  `@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

  `pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.

## 6.0.2

### Patch Changes

- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

- 882eacd: A doc whose only match is a wildcard tool (the raw viewer) but which suggests a
  package now shows just the offer, instead of dropping the reader into raw JSON
  that gets swapped out from under them once the import lands. If the import
  registers nothing, the view says so rather than sitting empty.

  The offer's toast is also themed: it took its colours from hardcoded light
  values while its button read `--studio-*`, so in a dark theme a light card held
  a black-on-black button. Both now use the theme's ink (`--studio-line` — the
  `--studio-text` they asked for doesn't exist), surface and accent.

## 6.0.1

### Patch Changes

- 94f6299: `<patchwork-view>` no longer imports a document's `suggestedImportUrl` on its own. When no tool supports the document but the document names a suggested import, the view says so — "No tool was found for this document, but it suggests a package at …" — and offers a "⚡ Load suggested package" button. Clicking it raises a `window.confirm` naming the URL whose JavaScript is about to run; nothing is fetched until that's accepted. When a wildcard fallback tool is already mounted, the same offer arrives as a toast instead of replacing it, dismissable with its × or Escape.

## 6.0.0

### Patch Changes

- eed5a2c: Dynamic handle remapping without remounts: `repo:handle-descriptor` is now a
  streaming subscription end-to-end.

  - `OverlayRepo.find`/`findWithProgress` keep their descriptor subscription
    open instead of taking only the first answer. When a remapper emits a new
    descriptor (e.g. a draft overlay re-pointing at a different clone), the live
    `OverlayHandle` is re-pointed in place via the new `swapBackingDocHandle`:
    forwarded event listeners are re-wired onto the new backing, cached
    sub-handles are recursively re-based, and a synthetic `change` event with
    `scopeReplaced: true` tells consumers to reconcile from `doc()` rather than
    apply patches (the old and new backings may be divergent forks). One-shot
    providers that answer exactly once keep working unchanged.
  - `forwardingProxy` accepts a backing getter so the proxy identity consumers
    hold stays fixed while the backing changes underneath.
  - `OverlayRepo` gained `dispose()`, which tears down the live descriptor
    subscriptions; `<patchwork-view>` calls it when the element disconnects
    (the overlay repo survives attribute-driven teardowns/re-syncs).
  - `OverlayHandle.emit` isolates listener errors (logged, not rethrown) so one
    consumer that cannot handle an event does not starve the listeners behind
    it, and skips listeners unsubscribed during the same emit so a torn-down
    consumer is never invoked with an event it already handed off.

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0

## 5.0.0

### Patch Changes

- Updated dependencies [9e6e0e0]
  - @inkandswitch/patchwork-plugins@1.1.0

## 4.0.4

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [f00dcb8]
  - @inkandswitch/patchwork-filesystem@0.2.5
  - @inkandswitch/patchwork-plugins@1.0.3

## 4.0.3

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [5f70c14]
  - @inkandswitch/patchwork-filesystem@0.2.4
  - @inkandswitch/patchwork-plugins@1.0.2

## 4.0.2

### Patch Changes

- bd63259: Declare `patchwork-view` in `HTMLElementTagNameMap`, so `document.querySelector("patchwork-view")` is typed. Move component-loading chatter to a `patchwork:elements:patchwork-view` debug logger.
- Updated dependencies [bd63259]
  - @inkandswitch/patchwork-filesystem@0.2.3

## 4.0.1

### Patch Changes

- c01e1f3: Give `<patchwork-view>` a proper exports map and test suite, and tear down its overlay repo on unmount.

  Add `registerPatchworkViewTag` so views registered under a custom tag name are still treated as subscription boundaries, and `OverlayRepo.dispose()`/`OverlayHandle.dispose()` so unmounting a view detaches the event forwarders it installed on backing handles.

- Updated dependencies [caca06f]
- Updated dependencies [c01e1f3]
  - @inkandswitch/patchwork-filesystem@0.2.2
  - @inkandswitch/patchwork-providers@0.4.2

## 4.0.0

### Minor Changes

- 82bee46: A doc's `suggestedImportUrl` may now be an `automerge:` folder-doc URL as well
  as an `http(s):` module bundle. When a view finds no built-in tool for a doc, it
  loads the suggested module either way. Adds `importPackage` (which dispatches on
  the URL scheme) and `isImportableSuggestedUrl` to `patchwork-filesystem`, and
  `getSuggestedImportUrl` now honors automerge URLs.

  The package-importing helpers are renamed from `module` to `package`, since they
  resolve a `package.json` entry point: `importModuleFromFolderDocUrl` →
  `importPackageFromFolderDocUrl`, `importModuleFromHttpUrl` →
  `importPackageFromHttpUrl`, and the `ModuleWatcher` `importAutomergeModule` hook
  (with bootloader's `importAutomergeModuleViaWorker`) → `importAutomergePackage`.

### Patch Changes

- Updated dependencies [82bee46]
  - @inkandswitch/patchwork-filesystem@0.2.0
  - @inkandswitch/patchwork-plugins@1.0.0

## 3.0.0

### Patch Changes

- Updated dependencies [2d39c84]
  - @inkandswitch/patchwork-providers@0.4.0

## 2.0.0

### Minor Changes

- 48e4391: Resolve a `<patchwork-view>`'s primary document handle through a realm-local
  `repo` instead of a global `window.repo`, and make legacy-tool resolution
  remappable via `OverlayRepo`.

  Breaking: `registerPatchworkViewElement` now requires a `repo` (its params
  argument is no longer optional), and `ComponentRender` callbacks now receive a
  second `repo` argument.
  - `registerPatchworkViewElement` now requires a realm-local `repo`. Each view
    wraps it in an `OverlayRepo` (exposed as `element.repo`) so legacy-mode tools
    resolve their primary handle through the remapping shim (e.g. to a draft
    clone), while components receive the base repo directly.
  - `ComponentRender` now receives the base repo as a second argument:
    `(element, repo) => () => void`. Components get the base repo (not the
    overlay) so providers can clone/create against the real repo without
    re-entering their own remapping.
  - `LegacyImpl` takes a required `repo` and resolves its handle through it,
    replacing the previous `globalThis.repo` lookup.

### Patch Changes

- Updated dependencies [48e4391]
  - @inkandswitch/patchwork-providers@0.3.0

## 1.0.0

### Patch Changes

- Updated dependencies [db46689]
  - @inkandswitch/patchwork-providers@0.2.0

## 0.2.0

### Minor Changes

- f4baf58: Add a `LegacyPatchworkViewElement` type for tools hosted in legacy
  (`doc-url` / `tool-id`) mode. Unlike the component-mode
  `PatchworkViewElement`, it always carries the resolved `repo` and
  optionally a `hive`, so legacy tools can read both off their mount host
  without casting.

  Relax the `<patchwork-view>` JSX attribute types: component mode now
  accepts `doc-url` / `tool-id` as passthrough data for the mounted
  component, and the Solid intrinsic extends `HTMLAttributes` so standard
  element props type-check. Renames the internal `PatchworkViewLegacyAttrs`
  to `LegacyPatchworkViewAttrs` for consistency.

## 0.1.0

### Minor Changes

- d9f4650: Reshape `<patchwork-view>` into a dual-mode element.

  The component-attribute mode (`<patchwork-view component="..." url="...">`)
  is the supported path going forward. The `doc-url` / `tool-id` mode is a
  deprecated migration bridge: every behavior it carries — tool registry
  lookups, `@patchwork.fallbackToolId` resolution, the `patchwork:no-tool`
  event, and the `LegacyImpl` plumbing that backs it — will be removed in
  a future major once consumers have moved to `patchwork:component`-based
  tools mounted via the `component` attribute. New code should not adopt
  `doc-url` / `tool-id`.

  Caveat: component mode currently only mounts `patchwork:component`
  plugins. It does not yet drive `patchwork:tool` plugins the way legacy
  mode does (tool-registry lookup by id, `@patchwork.fallbackToolId`
  resolution, `patchwork:no-tool` event). That tool-loading path will be
  folded into component mode in a future release; until then, anything
  that mounts a `patchwork:tool` still has to go through `doc-url` /
  `tool-id`.
  - `<patchwork-view>` now reacts to whichever attributes it carries.
    Given a `component` attribute (with an optional `url`), it mounts a
    registered `patchwork:component` plugin in place. Given the legacy
    `doc-url` / `tool-id` attributes (and no `component`), it drives the
    original tool-mounting lifecycle on itself via an internal
    `LegacyImpl` class. `component` wins if both are set.
  - Remove `registerPatchworkComponentElement` and the
    `<patchwork-component>` element; use `<patchwork-view component="...">`
    instead.
  - Emit a new `patchwork:unmounted` event (with `MountedEventDetail`-shaped
    payload) when a `<patchwork-view>` tears down, mirroring
    `patchwork:mounted`. `MountedEventDetail` is now a union covering
    both view (`{ url, toolId }`) and component (`{ componentId }`)
    mounts.
  - Update the `elements.d.ts` JSX intrinsic-element augmentations: the
    `patchwork-view` entry is now a discriminated union of legacy
    (`doc-url` / `tool-id`) and component (`component` / `url`) attribute
    sets — setting attributes from both modes on the same
    `<patchwork-view>` is a compile-time error. Applies to React, Solid,
    and the global `JSX` namespace.
  - Add `@inkandswitch/patchwork-providers` as a dependency and
    `react` / `solid-js` / `@types/react` as optional peers; legacy-mode
    rendering resolves the repo through an ancestor `<repo-provider>`
    instead of taking a `{ repo }` argument.
  - Tool render functions should type their element parameter as
    `PatchworkViewElement` (or `ToolElement` from `patchwork-plugins`).

- e0a7995: get back on the 0.x line

## 0.0.8

### Patch Changes

- a847c4f: release
- Updated dependencies [e6afa48]
- Updated dependencies [a847c4f]
  - @inkandswitch/patchwork-plugins@0.0.8
  - @inkandswitch/patchwork-filesystem@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies [435e9fe]
  - @inkandswitch/patchwork-plugins@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies [fd3dcdb]
  - @inkandswitch/patchwork-plugins@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [e3f41ee]
  - @inkandswitch/patchwork-filesystem@0.0.3
  - @inkandswitch/patchwork-plugins@0.0.3

## 0.0.2

### Patch Changes

- 1d6e833: Make the ts interface for the plugins array have the simple names Tool and Datatype
- Updated dependencies [1d6e833]
- Updated dependencies [1d6e833]
- Updated dependencies [1d6e833]
  - @inkandswitch/patchwork-plugins@0.0.2

## 0.0.1

### Patch Changes

- 33681ef: initial release

  making the packages available for the first time on npm

- Updated dependencies [33681ef]
  - @inkandswitch/patchwork-filesystem@0.0.1
  - @inkandswitch/patchwork-plugins@0.0.1
