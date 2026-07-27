# @inkandswitch/patchwork-plugins

## 1.1.0

### Minor Changes

- 9e6e0e0: Add a `createAccount` setup option, create required account subdocuments before exposing a fresh account, and stop exposing the account handle as `window.accountDocHandle`.

## 1.0.3

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [f00dcb8]
  - @inkandswitch/patchwork-filesystem@0.2.5

## 1.0.2

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [5f70c14]
  - @inkandswitch/patchwork-filesystem@0.2.4

## 1.0.1

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

## 1.0.0

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

## 0.0.11

### Patch Changes

- 0101e42: sync versions
- Updated dependencies [0101e42]
  - @inkandswitch/patchwork-filesystem@0.0.8

## 0.0.8

### Patch Changes

- e6afa48: Add `@inkandswitch/patchwork-bootloader/site` entry point exporting
  `bootPatchworkSite(config)`, a full browser-app boot sequence that constructs
  the Repo, wires the service-worker port, loads plugins via the ModuleWatcher,
  resolves the user's account, and installs URL-hash routing + dev globals. This
  lets per-site `main.ts` collapse to a ~10-line config object and keeps two
  sibling sites from drifting apart.

  Also removes the unused `@inkandswitch/patchwork-bootloader` devDependency from
  `@inkandswitch/patchwork-plugins`, which eliminated a cyclic workspace edge.

- a847c4f: release
- Updated dependencies [a847c4f]
  - @inkandswitch/patchwork-filesystem@0.0.6

## 0.0.5

### Patch Changes

- 435e9fe: add doc datatype to setTitle signature

## 0.0.4

### Patch Changes

- fd3dcdb: Make the Tool type generic

  so that the DocHandle has a natural type of the T of Tool<T>

## 0.0.3

### Patch Changes

- Updated dependencies [e3f41ee]
  - @inkandswitch/patchwork-filesystem@0.0.3

## 0.0.2

### Patch Changes

- 1d6e833: rename DataType to Datatype everywhere to be consistent with the id string and the crdt paper
- 1d6e833: warn when plugins are exporting legacy shapes
- 1d6e833: Make the ts interface for the plugins array have the simple names Tool and Datatype

## 0.0.1

### Patch Changes

- 33681ef: initial release

  making the packages available for the first time on npm

- Updated dependencies [33681ef]
  - @inkandswitch/patchwork-filesystem@0.0.1
