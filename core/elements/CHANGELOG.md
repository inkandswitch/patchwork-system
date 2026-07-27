# @inkandswitch/patchwork-elements

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
