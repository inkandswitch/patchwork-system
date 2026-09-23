# @inkandswitch/patchwork-bootloader

## 0.8.0

### Minor Changes

- 1cafc5e: Every Repo on the origin — each tab's `createRepo()` and the automerge protocol handler worker's, in both the plain and the keyhive branch — passes `headsChannel`, named `<storagePrefix>-heads`. When a tab persists commits it authored, its Repo posts the document's new heads on that BroadcastChannel; a sibling with the document open reloads it from the shared IndexedDB into its handle, and ignores announcements for documents it does not have open or heads it already knows. The channel also carries what the sync server holds: every tab talks to that server as the same identity, so one tab's `onRemoteHeads` observation is a fact for all of them, and each keeps the newest one per peer rather than the last one to arrive. Only a real observation is announced, never a relay of a relay. Every node keeps the same signer and peer id, its own socket to the sync server and the shared database; what changes is how a write in one tab reaches the others.

  The siblings mesh is gone with it: `siblingAdapters()` and the `@inkandswitch/patchwork-bootloader/siblings` export are removed, and no Repo passes `subductionAdapters`. Under one peer id the Subduction core never pushes a commit back to the sending peer's other connections, so the mesh links only added sync rounds.

  The option lives in this workspace's pnpm patch of `@automerge/automerge-repo@2.6.0-subduction.48`, which also carries three fixes: a `find` resolves from local storage as soon as shared storage holds the document, before the first server round; a `heads-changed` that saved nothing new (a reload, for instance) opens no server round; a document still initializing hydrates from local storage when a sync round fails while disconnected. A reload whose storage read fails is retried a few times, then logged once and left until the next announcement.

  A reload updates the handle, not the Subduction node's resident tree, so a commit that reached a tab only over the channel is one that tab cannot push: its hash is in the set every push is filtered against, and it is not in the tree a round reads. A containment backstop watches for that. When an entry's handle holds heads no peer has been seen holding, and a settling delay passes without a sibling reporting that the server has them, the tab writes those commits to storage a second time — which is what puts them in its tree — and then opens a round that can carry them. Each commit costs at most one such duplicate write, and a tab that is offline still does the write, so the reconnect round finds the tree already correct. The write is owed to the commit, not to the round: the cap on heal rounds gates the rounds alone, and a commit stops counting as stranded only once it has been stored or some peer has been seen holding it. Where every tab is online and pushing its own edits, the sibling's report arrives inside the settling delay and none of this runs.

  Consumers installing from npm get the unpatched fork, where `headsChannel` is ignored and tabs meet only through the server, until the fork is republished with these changes and the catalog pin is bumped.

### Patch Changes

- 7f54bd8: The automerge protocol handler worker evicts the documents its Repo loaded once no `automerge:` handoff has been in flight for five seconds. A page load is a burst of handoffs through the same folder documents; they now stay hot across the load and are released after it, instead of living in the SharedWorker for as long as any tab is open. A headless `automerge:<folder>/path` redirect waits up to three seconds for the folder to hold every head a connected Subduction peer has advertised, since a re-found folder comes back from IndexedDB before its sync round lands.

  Eviction goes through `Repo.removeFromCache`, which this workspace's pnpm patch of `@automerge/automerge-repo@2.6.0-subduction.48` makes real: `removeFromCache` awaits each source's `detach`, and the Subduction source's `detach` persists unsaved commits, runs one sync round if no peer has them, drops its entry and `heads-changed` listener, and unsubscribes the ephemeral topic, so the document can be collected and a later `find` attaches afresh. The Vite plugin ships and applies this patch for consumers installing `@inkandswitch/patchwork` from npm.

- f7d2e8c: IndexedDB is opened on the node's own thread: `createRepo` and the automerge protocol handler worker use `IndexedDBStorageAdapter` in place of `IndexedDBWorkerStorageAdapter`. Measured in `sites/bench`, the worker adapter bought no main-thread time (same boot, same cold load of 40 documents, 1ms flush latency either way) and cost a dedicated worker per tab, about 30 MB across three. The origin-wide signer is unchanged.
- 32ed577: `@automerge/automerge-repo-keyhive` is loaded only where keyhive is in use: `createRepo` and the automerge protocol handler worker `import()` it inside their keyhive branch, and `patchwork-elements` and `patchwork-plugins` no longer import it at runtime. Its entry module carries the keyhive wasm as a 3 MB base64 string, so the static imports put a 3.1 MB chunk in every tab's modulepreload list and in the worker whether or not the site enabled keyhive, at 7 to 10 MB of memory per tab, and 8 MB in the protocol-handler worker. The chunk is still emitted under `/packages/` and listed in the import map for tool code. Type imports are unchanged.

  `isKeyhiveDoc` in `patchwork-plugins`, and the keyhive access gates in `patchwork-elements`, decide from the document id's bytes: an id shorter than 32 bytes, or one whose bytes 16 through 31 are all zero, is a legacy document. They used to construct a keyhive `DocumentId` and take a throw as legacy, but that constructor is an ed25519 point decode and accepts about half of legacy padded ids, so about half of legacy documents went through `bestAccessForDoc`. This is the check behind ARK's `isUnprotectedDoc`, which it recommends over the deprecated `docIdFromAutomergeUrl`.

  When keyhive access to a document changes, `patchwork-elements` looks up the document's handle by its automerge document id before retrying. It used the keyhive `DocumentId` string, which is hex and never matched a handle, so an unavailable handle was never dropped before the retry.

  The vite plugin gives the worker chunks an empty module-preload dependency list. Vite wraps a dynamic import in a preload helper that touches `document` when it has dependencies to preload, and a worker has no `document`.

- 1d22480: Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

  The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

  `initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

  `@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

  `pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.

- aa9af7e: The tab no longer heartbeats the automerge SharedWorker. The ping/pong, the second-connection probe, instance ids, and the recovery rate limit are gone: since every tab is its own Subduction node, the worker's control port carries only console forwarding, a debug toggle, and `connectClassicSync`, so a silent port strands nothing. The worker is respawned on the next `get()` if the browser terminates it (its control port fires `close`). `SharedWorkerHandle.onRecreated` is removed; it had no listeners. `@inkandswitch/patchwork` drops its page-lifecycle logging, which existed to line up against sync-socket reaps in a worker that no longer holds the tab's socket.
- 1d22480: The service worker no longer re-caches a passthrough response whose etag matches the copy it already holds. Every tab boot used to clone the whole bundle's responses and write them back to Cache Storage, holding a second copy of each body in the service worker's process until the write landed; with several tabs opening at once that peaked at a few hundred MB.
- Updated dependencies [32ed577]
- Updated dependencies [1d22480]
  - @inkandswitch/patchwork-elements@6.0.3
  - @inkandswitch/patchwork-plugins@1.2.6
  - @inkandswitch/patchwork-filesystem@0.2.10
  - @inkandswitch/patchwork-providers@0.5.3

## 0.7.2

### Patch Changes

- 483e23c: Bump @automerge/automerge to 3.5.0.

## 0.7.1

### Patch Changes

- 5462610: Move keyhive out of `syncServers` and into its own top-level site option: `keyhive?: boolean | { syncServer?, useIdFactory? }`. `keyhive: true` enables it against the `"subduction"` relay; the object form picks a different relay (or a custom `{url, contactCardJson, peerId}` identity) and turns individual behaviour off. `keyhive.useIdFactory: false` drops the `idFactory` ARK injects into the repo config, so document ids are generated the Repo's own way instead of derived from keyhive. It reaches both the tab repo and the automerge protocol handler worker through the `__SYNC_SERVER__` define.

  `syncServers` is now just URLs — `subduction` and `classic`, no longer mutually exclusive with anything. Sites passing `syncServers: { keyhive: X }` should pass `keyhive: { syncServer: X }` instead; `syncServers.subduction` still overrides the URL a named relay implies.

- 5462610: Persist the Subduction signer so every context on an origin presents the same identity. The seed lives in the shared IndexedDB, so tabs and the automerge protocol handler worker adopt one signer instead of each minting a fresh `MemorySigner` on load. Generating it takes a Web Lock, so a cold profile opening two contexts at once still settles on one seed.

  `@inkandswitch/patchwork-bootloader/signer` is a new export: `loadOrCreateSigner(storage)` returns the origin's `MemorySigner`, generating and storing a seed the first time.

## 0.7.0

### Minor Changes

- 2e71745: Every Repo on the origin is its own Subduction node. A tab holds this origin's IndexedDB, keeps its own WebSocket to the sync server, and meets the other tabs over a BroadcastChannel carrying Subduction (`siblingAdapters()` in `@inkandswitch/patchwork-bootloader/siblings`, passed to `new Repo({ subductionAdapters })`). The automerge SharedWorker no longer sits between tabs and storage — it is one more such node, kept only to resolve `automerge:` URLs for the service worker, which can't own a Repo itself. The websocket proxy worker is gone with it.

  Benchmarked against the shared-worker arrangement (`sites/bench`): boot and memory are a wash or better, cross-tab propagation matches, and two shared-worker failures go away — a `find()` racing a sibling's `create()` settled as unavailable, and edits made just before a tab closed were lost, since a storageless tab had nothing to flush to. Each tab flushing its own IndexedDB closes both.

  Keyhive sites use the subduction-backed hive in both the tab and the worker, each talking to the sync server directly.

  `patchwork.sw.subscribeSyncState(documentId, listener)` stays, now a filter over the tab's own Repo's `subduction-remote-heads` event, replaying the server's current heads from `handle.getSyncInfo()` on subscribe; `SyncStateDocMessage` is exported from `@inkandswitch/patchwork`. Removed from `setupServiceWorker()`'s result: `subscribeToRepoChannel`, `getRepoChannel`, `subscribeSyncState`. The `@patchwork/syncstate` BroadcastChannel and the other `SyncState*` message types are gone too; a tab's own Repo has what they carried — `repo.isSubductionConnected()` and the `subduction-connection` event for the link, `repo.connectedSubductionPeerIds()` for which peers are the server, and `patchwork.signerIdentity` for this tab's peer id. `createRepo` in `@inkandswitch/patchwork` takes no arguments.

  `@inkandswitch/patchwork-bootloader` depends on `@automerge/automerge-repo-network-broadcastchannel`, which is also on the importmap.

  That worker is renamed for what it now does: `@inkandswitch/patchwork-bootloader/automerge-worker` is now `@inkandswitch/patchwork-bootloader/automerge-protocol-handler-worker`, emitted as `automerge-protocol-handler-worker.js` (the `workerPath` option on `setupServiceWorker` still overrides it), and `getAutomergeWorker()` is now `getAutomergeProtocolHandlerWorker()`.

  Inter-tab sync is Subduction, not classic automerge sync. `connectSiblings(repo, hive)` is replaced by `siblingAdapters()`, which returns the `subductionAdapters` entries for a Repo rather than mutating one after the fact, so it is passed to the `Repo` constructor. The frames on the siblings BroadcastChannel are Subduction transport frames authenticated by each node's own signer; the keyhive network adapter no longer wraps that channel, since keyhive material reaches siblings the same way it reaches the sync server. The one remaining classic-sync path is the opt-in classic sync server the protocol handler worker connects to on request.

  Subduction's handshake has an initiator and a responder, and a BroadcastChannel is a mesh, so the siblings adapter is passed with `role: "mesh"`, added to the automerge-repo fork's `subductionAdapters` by this repo's pnpm patch: for each pair of peers on the adapter, the one whose peer id sorts lower initiates the handshake and the other accepts.

### Patch Changes

- 47bc4cf: `@automerge/automerge` goes to `3.4.1`, and `@automerge/automerge-repo-network-broadcastchannel` joins the automerge-repo family at `2.6.0-subduction.48`.
- Updated dependencies [47bc4cf]
  - @inkandswitch/patchwork-filesystem@0.2.9
  - @inkandswitch/patchwork-plugins@1.2.4

## 0.6.3

### Patch Changes

- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

- Updated dependencies [ebca53b]
- Updated dependencies [882eacd]
  - @inkandswitch/patchwork-elements@6.0.2
  - @inkandswitch/patchwork-filesystem@0.2.8
  - @inkandswitch/patchwork-plugins@1.2.3
  - @inkandswitch/patchwork-providers@0.5.2

## 0.6.2

### Patch Changes

- f37bb8e: Bump `@automerge/automerge-subduction` to 0.16.1.

## 0.6.1

### Patch Changes

- 846cfac: Update the pinned `@automerge/*` versions to `2.6.0-subduction.47`. These are exact pins in `dependencies` and `peerDependencies`, so both packages need to ship the new version together — installing a `.46` and a `.47` package side by side loads two copies of automerge-repo, and document handles from one are not recognised by the other.
- 61a152a: Make `vite dev` work without a site hand-rolling the dev server.

  The build emits the service worker, the automerge shared worker, the module-loader worker, and three wasm binaries. None of them existed in serve mode, so every one 404'd and dev only worked if a site served a previous production build's `dist/` behind vite. The plugin now serves all of them itself:

  - The three worker entries are bundled on demand with esbuild and rebuilt per request, so they always reflect the source on disk. Their heavy imports resolve to the dev server's optimized-dep URLs, mirroring how the build rewrites them to `/packages/...` — import maps don't apply to `type: "module"` workers, so the URLs have to be real either way.
  - `automerge.wasm`, `keyhive_wasm.wasm`, and `subduction.wasm` are served from the bootloader's own node_modules. `@inkandswitch/patchwork-bootloader/externals` gains `wasmAssets()`, which `emitWasmAssets` now uses too.
  - `global.css` 404'd in dev: the generated `index.html` links it by bare specifier, which only the build resolves. Both patchwork's and the bootloader's stylesheets are now served under root-absolute paths, and the link points at them.
  - `@patchwork/service-worker` called `emitFile` from `buildStart` unconditionally, which throws in serve mode — it logged "This plugin is likely not vite-compatible" three times on every dev-server start. It now skips emission when serving.
  - Dep pre-bundling runs esbuild outside the plugin pipeline that applies `define`, so in dev the page fell back to the default storage prefix while the workers used the configured one — the two would have opened different IndexedDB databases. The defines are now passed to the optimizer as well.

  Sites no longer need to filter `@patchwork/service-worker` out of the plugin list, serve stylesheets themselves, or keep a built `dist/` around for `vite dev`.

## 0.6.0

### Minor Changes

- 98be594: Namespace IndexedDB and peer ids with a new build-time `storagePrefix` option.

  The tab and the shared automerge worker are separate bundles that must open the same databases. Both now read the name from one place, `@inkandswitch/patchwork-bootloader/storage`, resolved from the `__STORAGE_PREFIX__` define the vite plugin emits unconditionally.

  Previously each side resolved `__SITE_NAME__` itself with a different fallback — `"patchwork.inkandswitch.com"` in the worker, `"patchwork"` in the tab — so a site that never set `siteName` had its tab and worker on two different keyhive databases, and one that passed `setup({name})` split them the same way, since a runtime option never reaches the worker.

  - `storagePrefix` defaults to `"patchwork"` and is settable only in the build config. Sites sharing an origin must use distinct prefixes. It is deliberately not derived from any display name: changing it points a site at empty storage, so a rebrand must not be able to change it by accident.
  - Sites that relied on `siteName` to namespace their storage must now set `storagePrefix` explicitly to that same value to keep their existing databases.
  - `createRepo` in `@inkandswitch/patchwork` no longer takes a site name argument.

## 0.5.4

### Patch Changes

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0
  - @inkandswitch/patchwork-elements@6.0.0

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
