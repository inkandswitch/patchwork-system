# @inkandswitch/patchwork-bootloader

## 0.5.3

### Patch Changes

- Updated dependencies [9e6e0e0]
  - @inkandswitch/patchwork-plugins@1.1.0
  - @inkandswitch/patchwork-elements@5.0.0

## 0.5.2

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [f00dcb8]
  - @inkandswitch/patchwork-filesystem@0.2.5
  - @inkandswitch/patchwork-elements@4.0.4
  - @inkandswitch/patchwork-plugins@1.0.3

## 0.5.1

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [5f70c14]
  - @inkandswitch/patchwork-filesystem@0.2.4
  - @inkandswitch/patchwork-elements@4.0.3
  - @inkandswitch/patchwork-plugins@1.0.2

## 0.5.0

### Minor Changes

- bd63259: Move the site boot sequence and the vite plugin out to `@inkandswitch/patchwork`. The `./site` and `./vite` exports are gone; import from `@inkandswitch/patchwork` and `@inkandswitch/patchwork/vite` instead.

  Split the externals list into `./externals-list` so the list can be read without pulling in node builtins, and export `resolveExternal` and the wasm asset emitter so another package's vite plugin can resolve the bootloader's own dependencies from the bootloader's `node_modules`. Export `./global.css` and `./module-loader`.

  Fall back to a url-keyed cache lookup in the service worker when the request-keyed one misses, so a cors request (the wasm `<link rel=preload crossorigin>`) still hits the cache offline.

### Patch Changes

- 0aa315d: Configure Subduction or Keyhive with exclusive `syncServers` configuration. `syncServers.keyhive` replaces the `keyhive` and `keyhiveSyncServer` site options and the runtime `setup({ keyhive })` option. Selecting a named ARK relay or providing a custom relay identity and URL enables Keyhive, and configured server URLs now control worker connections as well as connection hints.
- Updated dependencies [bd63259]
- Updated dependencies [bd63259]
  - @inkandswitch/patchwork-elements@4.0.2
  - @inkandswitch/patchwork-filesystem@0.2.3

## 0.4.4

### Patch Changes

- c01e1f3: Switch the service worker's active cache name before copying the default cache into it, so fetches landing mid-copy aren't deleted with the old cache. Guard the message handler against payload-less messages, and drop the `window.killsw` debug hook.
- Updated dependencies [caca06f]
- Updated dependencies [c01e1f3]
  - @inkandswitch/patchwork-filesystem@0.2.2
  - @inkandswitch/patchwork-providers@0.4.2
  - @inkandswitch/patchwork-elements@4.0.1

## 0.4.3

### Patch Changes

- bd9cd3d: Reliability and boot-speed fixes:

  - The service worker no longer blocks responses on cache writes (they move to
    `waitUntil`), page caching writes its three entries in parallel, non-GET
    requests bypass the worker entirely, cache-write failures (e.g. quota) are
    always logged, the cache is capped at 2000 entries with oldest-first
    trimming, and boot requests persistent storage so cache growth can't trip
    origin-wide eviction of user data.
  - `automerge.wasm` is fetched under one URL from both the tab and the
    automerge worker (the `?main`/`?worker` tracing query strings defeated the
    HTTP cache, the SW cache, and the sites' preload — the ~3MB body downloaded
    twice).
  - Tabs now recover when the automerge SharedWorker dies or its connection is
    stranded. Previously death was only logged and tabs silently stopped syncing
    until reload. Silence alone never tears anything down (a slow-booting or
    busy worker delivers everything queued once it catches up): a silent port
    first starts a non-destructive probe — a second connection to the same
    instance — and only when the probe gets a `hello` while the original port
    stays silent (proving a live instance with a stranded port) is the worker
    handle recreated, with sync-state subscriptions replayed and every
    subscriber's repo re-wired onto a fresh port. This rescues boots whose
    initial SharedWorker port comes up deaf (~6s), including in hidden
    background tabs; a port `close` event still recovers immediately.
  - The worker no longer rescans every doc handle on every
    `subduction-remote-heads` event (quadratic during sync bursts); it tracks
    just the reported doc.
  - `ModuleWatcher` announces are generation-tracked, so a stale retry of an
    older module version can no longer land after a newer version and roll the
    registry back.
  - `resolveAccountHandle` never overwrites a valid stored account pointer when
    `repo.find` fails: it retries briefly and then throws, instead of silently
    creating a fresh account and orphaning the user's workspace.
  - `OverlayRepo` no longer memoizes rejected resolutions: a `find` that failed
    because the doc (or its keyhive access) hadn't synced yet used to pin every
    later `find` of that url to the same cached rejection, so the views' "retry
    once access syncs" recovery could never reach the base repo. Rejections now
    evict and the next `find` re-resolves. `findWithProgress().subscribe` also
    no longer leaks its inner subscription (or fires the callback) when
    unsubscribed before the resolution settles.

- Updated dependencies [bd9cd3d]
  - @inkandswitch/patchwork-filesystem@0.2.1
  - @inkandswitch/patchwork-plugins@1.0.1
  - @inkandswitch/patchwork-providers@0.4.1

## 0.4.2

### Patch Changes

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

- Updated dependencies [82bee46]
  - @inkandswitch/patchwork-filesystem@0.2.0
  - @inkandswitch/patchwork-elements@4.0.0
  - @inkandswitch/patchwork-plugins@1.0.0

## 0.4.1

### Patch Changes

- Updated dependencies [2d39c84]
  - @inkandswitch/patchwork-providers@0.4.0
  - @inkandswitch/patchwork-elements@3.0.0

## 0.4.0

### Minor Changes

- b1bd763: Hash routing: `doc=` now holds the full (un-encoded) automerge URL — heads, if
  any, live inside it — and the separate `heads=` param is gone. `doc=` values
  that are a bare document id are still accepted for backwards compatibility, and
  legacy big-patchwork links (`<slug>--<docId>?…`, including slugs with
  characters like `drawing-(branch-1)`) are normalized to `#doc=automerge:<docId>`.

## 0.3.2

### Patch Changes

- 0e1eb95: add syncstate info shape

## 0.3.1

### Patch Changes

- 099e931: Discover a package's plugin descriptors in a dedicated module worker off the
  main thread, then re-import the package (pinned to the same heads) on the main
  thread to run each plugin's real loader. Adds
  `importPluginFromFolderDocUrl(folderDocUrl, pluginType, pluginId)`, which selects
  the plugin by both its `type` and `id` — a plugin `id` is only unique within a
  plugin type, so a package may export e.g. a `patchwork:datatype` and a
  `patchwork:tool` that share the same id.
- Updated dependencies [099e931]
  - @inkandswitch/patchwork-filesystem@0.1.1

## 0.2.8

### Patch Changes

- 48e4391: Pass the realm-local `repo` to `<patchwork-view>` registration so booted views
  resolve their document handles through it — via the per-view `OverlayRepo` and
  the root `<repo-provider>` fallback for `repo:handle-descriptor`.
- Updated dependencies [48e4391]
- Updated dependencies [48e4391]
  - @inkandswitch/patchwork-elements@2.0.0
  - @inkandswitch/patchwork-providers@0.3.0

## 0.2.7

### Patch Changes

- 14bd0e2: Don't externalize @automerge/automerge-repo-react-hooks

## 0.2.6

### Patch Changes

- Updated dependencies [db46689]
  - @inkandswitch/patchwork-providers@0.2.0
  - @inkandswitch/patchwork-elements@1.0.0

## 0.2.5

### Patch Changes

- Updated dependencies [f4baf58]
  - @inkandswitch/patchwork-elements@0.2.0

## 0.2.4

### Patch Changes

- Updated dependencies [d9f4650]
- Updated dependencies [e0a7995]
  - @inkandswitch/patchwork-elements@0.1.0

## 0.2.3

### Patch Changes

- 0101e42: sync versions
- Updated dependencies [0101e42]
  - @inkandswitch/patchwork-elements@1.0.3
  - @inkandswitch/patchwork-filesystem@0.0.8
  - @inkandswitch/patchwork-plugins@0.0.11
  - @inkandswitch/patchwork-providers@0.1.2

## 0.2.0

### Minor Changes

- 76db23e: Wire the new `@inkandswitch/patchwork-providers` element stack into
  `bootPatchworkSite`:
  - Register and mount `<repo-provider>` (backed by the booted repo) and a
    top-level `<fallback-provider>` around the configured root element so
    descendant `<patchwork-view>` / `<patchwork-view-legacy>` elements can
    resolve their repo via the request/respond protocol.
  - The single `registerPatchworkViewElement()` call now also registers
    `<patchwork-view-legacy>` (the wrapper's delegation target), so no
    separate registration is needed.
  - Drop the `{ repo }` argument from `registerPatchworkViewLegacyElement`
    (the repo now comes from the provider).
  - Add `@inkandswitch/patchwork-providers` as a workspace dependency.

### Patch Changes

- Updated dependencies [76db23e]
- Updated dependencies [76db23e]
  - @inkandswitch/patchwork-elements@1.0.0
  - @inkandswitch/patchwork-providers@0.1.0

## 0.1.0

### Minor Changes

- e6afa48: Add `@inkandswitch/patchwork-bootloader/site` entry point exporting
  `bootPatchworkSite(config)`, a full browser-app boot sequence that constructs
  the Repo, wires the service-worker port, loads plugins via the ModuleWatcher,
  resolves the user's account, and installs URL-hash routing + dev globals. This
  lets per-site `main.ts` collapse to a ~10-line config object and keeps two
  sibling sites from drifting apart.

  Also removes the unused `@inkandswitch/patchwork-bootloader` devDependency from
  `@inkandswitch/patchwork-plugins`, which eliminated a cyclic workspace edge.

### Patch Changes

- a847c4f: release
- Updated dependencies [e6afa48]
- Updated dependencies [a847c4f]
  - @inkandswitch/patchwork-plugins@0.0.8
  - @inkandswitch/patchwork-elements@0.0.8
  - @inkandswitch/patchwork-filesystem@0.0.6

## 0.0.4

### Patch Changes

- e3f41ee: republish broken packages

## 0.0.1

### Patch Changes

- 33681ef: initial release

  making the packages available for the first time on npm
