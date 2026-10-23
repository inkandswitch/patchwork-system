# @inkandswitch/patchwork-filesystem

## 0.2.14

### Patch Changes

- 3d2d0b0: Package heads lookups no longer pile up on a busy automerge worker. A package doc that's still syncing, as everything is on a fresh login, reports a change with every batch that arrives. The `ModuleWatcher` started a lookup for each one, and the automerge worker ran each as a full resolve with its own 30-second timeout. A worker slowed by the login sync then timed them all out, and each logged its own 557.

  The `ModuleWatcher` now runs one change-triggered lookup per package at a time. Changes that land while one is in flight collapse into a single lookup after it. The automerge worker shares one resolve between concurrent requests for the same package url without heads, so tabs asking at once wait on the same lookup.

- 3d2d0b0: When the service worker can't redirect a package url to its heads, the error now includes the automerge worker's reason (the first line of its 557 body — e.g. the doc is unavailable, or the resolve timed out) instead of only the status.
- Only cache resolved paths when the root and every followed link pin their document heads.

## 0.2.13

### Patch Changes

- 87f13ef: Tools can ask the automerge worker how much memory a package's documents take to load, so a packages view can show which packages are the expensive ones. The worker is what loads a package's documents to serve its files, so it measures them there rather than in the tab asking.

  - `PACKAGE_MEMORY_CHANNEL` (`@patchwork/package-memory`, in `@inkandswitch/patchwork-bootloader/types`): post a `PackageMemoryRequestMessage` with the package's root URL. The worker answers `accepted` straight away, then a `PackageMemoryReplyMessage` listing documents with their path, ops, changes, the ops in their biggest single change, and how a file's `content` is stored (text, `ImmutableString` or bytes) and its length.
  - By default the answer is what the worker has loaded of the package since it started, each document measured as it was loaded to serve a file: what the package actually costs, and asking loads nothing. With `walk: true` the worker loads every document in the package to measure it, a package at a time and a document at a time, letting each go once it's measured unless a file is being resolved meanwhile, and fetching any it hasn't stored. That covers files nothing has asked for, like READMEs and lockfiles, but it's slow, and measuring a document with one huge change costs the worker as much memory as loading it does. A document that can't be found within 15s is listed with the error and the walk goes on.
  - The biggest change is the number to look at. What a load costs grows faster than its ops, and much faster for one big change: a file's text written as a plain string in one change is an op per character, all in that change, and one of 585k characters took ~300 MB of wasm memory to load.
  - `packageDocuments(repo, root)` in `@inkandswitch/patchwork-filesystem` walks every document `resolvePath` can reach from a package's root (directory and folder docs, links as strings or `ImmutableString`s), root first, finding each only when it's reached.

## 0.2.12

### Patch Changes

- 7a82d45: `resolvePath` follows a link stored as an `ImmutableString` as well as one stored as a plain string, in a directory doc's entries, a folder doc's `docs[].url`, and wherever a path ends on a link. An `ImmutableString` reads back as an object, so these were taken for something that isn't a link: the path stopped there, or the URL itself was served as the file's contents. pushwork writes package links as `ImmutableString`s, which are one op where a plain string is an op per character, rewritten on every push.

## 0.2.11

### Patch Changes

- 7ab0d68: A tab no longer keeps every package's doc in memory just to hear when a package changes. The ModuleWatcher used to hold each package's folder or directory doc in the tab's Repo for the life of the page, only to listen for new heads. It now finds a package's latest version by asking the service worker for its url without heads, which the automerge worker redirects to the url at the doc's latest heads (letting go of the doc 5s later, as it does for every request). It hears about new versions from the sync node, which keeps the doc subscribed with the server and says when something arrives for it, without the tab loading it.

  The sync node takes `watch`/`unwatch` for a sedimentree and answers `changed`, with no data, whenever it gets something for it from the server or from a tab's write, the writing tab's watchers included. A watch subscribes the doc with the server if the node hasn't since it started, and again after the connection drops. `PortSyncRemote` gets `watch(sid, onChange)`, which sends its watches again after a worker restart and calls every watcher once, since the doc may have moved while there was no node. `@inkandswitch/patchwork-bootloader` exports this as `watchDocument(url, onChange)`, which returns the function that stops it, and `getSedimentreeId(url)` for the sedimentree id of a document.

  `@inkandswitch/patchwork-filesystem` adds `PackageTracker`, how a ModuleWatcher finds a package's latest version (`findLatest`) and hears there may be a newer one (`watch`), as a new last argument to the `ModuleWatcher` constructor. The default, `trackPackagesInRepo(repo)`, holds the package docs in the Repo as before. `trackPackagesViaServiceWorker(watch)` is the browser one, and patchwork's `setup()` now passes it with `watchDocument`. `fetchLatestViaServiceWorker` and `getDefaultBranch` are exported too.

  A deprecated branches doc in the module settings is now followed to its default branch by the automerge worker, on any url without heads, rather than by the tab.

## 0.2.10

### Patch Changes

- 1d22480: Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

  The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

  `initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

  `@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

  `pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.

## 0.2.9

### Patch Changes

- 47bc4cf: `@automerge/automerge` goes to `3.4.1`, and `@automerge/automerge-repo-network-broadcastchannel` joins the automerge-repo family at `2.6.0-subduction.48`.

## 0.2.8

### Patch Changes

- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

## 0.2.7

### Patch Changes

- 3e67841: Split the datatype's import URL when creating a doc: `@patchwork.suggestedImportUrl` now holds the URL with the heads stripped, and `@patchwork.frozenImportUrl` holds the full URL including heads. `getFrozenImportUrl` reads the latter. URLs without heads are unchanged and set no `frozenImportUrl`.

## 0.2.6

### Patch Changes

- a96f250: Store the datatype's import URL without heads in `@patchwork.suggestedImportUrl`, and record the heads separately in `@patchwork.suggestedImportUrlHeads`. A doc created from a package pinned to specific heads now suggests the package itself, with the pin kept alongside it.

## 0.2.5

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.2.4

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.2.3

### Patch Changes

- bd63259: Move module reload chatter to a `patchwork:modules` debug logger, and report module load failures with `console.error` instead of `console.log`.

## 0.2.2

### Patch Changes

- caca06f: Remove branch support from modules, falling back to the default branch. Handle module-watcher instability. Drop the react and solid packages.

## 0.2.1

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

## 0.2.0

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

## 0.1.3

### Patch Changes

- 0c6177a: An HTTP(S) module URL in a module-settings doc may now point at a site/directory that serves a `package.json` rather than straight at an entry file. When the URL doesn't already name a module file, its `package.json` is fetched and the entry point (`exports`/`main`) resolved and imported. URLs that already point directly at a file still import as-is.

## 0.1.2

### Patch Changes

- 923ad66: Resolve importable URLs against `globalThis.document.baseURI` (falling back to `globalThis.origin`) so they are absolute rather than root-relative.

## 0.1.1

### Patch Changes

- 099e931: Discover a package's plugin descriptors in a dedicated module worker off the
  main thread, then re-import the package (pinned to the same heads) on the main
  thread to run each plugin's real loader. Adds
  `importPluginFromFolderDocUrl(folderDocUrl, pluginType, pluginId)`, which selects
  the plugin by both its `type` and `id` — a plugin `id` is only unique within a
  plugin type, so a package may export e.g. a `patchwork:datatype` and a
  `patchwork:tool` that share the same id.

## 0.0.8

### Patch Changes

- 0101e42: sync versions

## 0.0.6

### Patch Changes

- a847c4f: release

## 0.0.3

### Patch Changes

- e3f41ee: republish broken packages

## 0.0.1

### Patch Changes

- 33681ef: initial release

  making the packages available for the first time on npm
