# @inkandswitch/patchwork

## 0.8.3

### Patch Changes

- 2558064: The vite plugin applies this repo's pnpm patch of `@automerge/automerge-repo` (`patches/@automerge__automerge-repo@<version>.patch`, shipped in the package as `dist/patches/`) to every copy of automerge-repo vite bundles for a site, in place of the two hand-written edits it carried before. A site installing from npm gets the same automerge-repo as this workspace: the real `detach` behind eviction, the `mesh` adapter role, and whatever else the patch holds.

  Covered: the page build's chunks, including the `/packages/@automerge/automerge-repo*.js` import-map chunks that patchwork's own protocol-handler worker imports from; the dev server's pre-bundled deps (an esbuild `onLoad` plugin in `optimizeDeps`); and module workers a site builds through vite (`new Worker(new URL("./x.ts", import.meta.url), { type: "module" })`), which vite bundles in a separate rollup pass with only `worker.plugins` — the `config()` plugin's worker config now sets `worker.plugins` to `[wasm(), patches({ complete: false })]`, so those bundles are patched too. A site that passes `worker: false` and writes its own `worker.plugins` has to add `patches({ complete: false })` to them itself.

  `patches()` fails the build if any file the patch edits never reached the bundler; `patches({ complete: false })` skips that check, for a worker bundle that may import none or only some of them. The patch is pinned to one automerge-repo version; a version bump fails the build until the patch is re-made against it.

- 1cafc5e: Every Repo on the origin — each tab's `createRepo()` and the automerge protocol handler worker's, in both the plain and the keyhive branch — passes `headsChannel`, named `<storagePrefix>-heads`. When a tab persists commits it authored, its Repo posts the document's new heads on that BroadcastChannel; a sibling with the document open reloads it from the shared IndexedDB into its handle, and ignores announcements for documents it does not have open or heads it already knows. The channel also carries what the sync server holds: every tab talks to that server as the same identity, so one tab's `onRemoteHeads` observation is a fact for all of them, and each keeps the newest one per peer rather than the last one to arrive. Only a real observation is announced, never a relay of a relay. Every node keeps the same signer and peer id, its own socket to the sync server and the shared database; what changes is how a write in one tab reaches the others.

  The siblings mesh is gone with it: `siblingAdapters()` and the `@inkandswitch/patchwork-bootloader/siblings` export are removed, and no Repo passes `subductionAdapters`. Under one peer id the Subduction core never pushes a commit back to the sending peer's other connections, so the mesh links only added sync rounds.

  The option lives in this workspace's pnpm patch of `@automerge/automerge-repo@2.6.0-subduction.48`, which also carries three fixes: a `find` resolves from local storage as soon as shared storage holds the document, before the first server round; a `heads-changed` that saved nothing new (a reload, for instance) opens no server round; a document still initializing hydrates from local storage when a sync round fails while disconnected. A reload whose storage read fails is retried a few times, then logged once and left until the next announcement.

  A reload updates the handle, not the Subduction node's resident tree, so a commit that reached a tab only over the channel is one that tab cannot push: its hash is in the set every push is filtered against, and it is not in the tree a round reads. A containment backstop watches for that. When an entry's handle holds heads no peer has been seen holding, and a settling delay passes without a sibling reporting that the server has them, the tab writes those commits to storage a second time — which is what puts them in its tree — and then opens a round that can carry them. Each commit costs at most one such duplicate write, and a tab that is offline still does the write, so the reconnect round finds the tree already correct. The write is owed to the commit, not to the round: the cap on heal rounds gates the rounds alone, and a commit stops counting as stranded only once it has been stored or some peer has been seen holding it. Where every tab is online and pushing its own edits, the sibling's report arrives inside the settling delay and none of this runs.

  Consumers installing from npm get the unpatched fork, where `headsChannel` is ignored and tabs meet only through the server, until the fork is republished with these changes and the catalog pin is bumped.

- f7d2e8c: IndexedDB is opened on the node's own thread: `createRepo` and the automerge protocol handler worker use `IndexedDBStorageAdapter` in place of `IndexedDBWorkerStorageAdapter`. Measured in `sites/bench`, the worker adapter bought no main-thread time (same boot, same cold load of 40 documents, 1ms flush latency either way) and cost a dedicated worker per tab, about 30 MB across three. The origin-wide signer is unchanged.
- 32ed577: `@automerge/automerge-repo-keyhive` is loaded only where keyhive is in use: `createRepo` and the automerge protocol handler worker `import()` it inside their keyhive branch, and `patchwork-elements` and `patchwork-plugins` no longer import it at runtime. Its entry module carries the keyhive wasm as a 3 MB base64 string, so the static imports put a 3.1 MB chunk in every tab's modulepreload list and in the worker whether or not the site enabled keyhive, at 7 to 10 MB of memory per tab, and 8 MB in the protocol-handler worker. The chunk is still emitted under `/packages/` and listed in the import map for tool code. Type imports are unchanged.

  `isKeyhiveDoc` in `patchwork-plugins`, and the keyhive access gates in `patchwork-elements`, decide from the document id's bytes: an id shorter than 32 bytes, or one whose bytes 16 through 31 are all zero, is a legacy document. They used to construct a keyhive `DocumentId` and take a throw as legacy, but that constructor is an ed25519 point decode and accepts about half of legacy padded ids, so about half of legacy documents went through `bestAccessForDoc`. This is the check behind ARK's `isUnprotectedDoc`, which it recommends over the deprecated `docIdFromAutomergeUrl`.

  When keyhive access to a document changes, `patchwork-elements` looks up the document's handle by its automerge document id before retrying. It used the keyhive `DocumentId` string, which is hex and never matched a handle, so an unavailable handle was never dropped before the retry.

  The vite plugin gives the worker chunks an empty module-preload dependency list. Vite wraps a dynamic import in a preload helper that touches `document` when it has dependencies to preload, and a worker has no `document`.

- 86d59d4: Add the `importModulesInWorker` setup option. It defaults to `true`, keeping plugin-descriptor discovery in the module-loader worker; `false` imports each Automerge package directly on the main thread instead.
- 1d22480: Every tab and worker now runs one automerge wasm instance, streamed from `/automerge.wasm`.

  The bare `@automerge/automerge`, `@automerge/automerge-repo`, `@automerge/automerge-subduction` and `@keyhive/keyhive` specifiers resolve to their `/slim` builds everywhere: in the vite plugin's bundle, in the importmap a tool sees at runtime, and in the dev server's worker bundles. The fullfat entries embed and instantiate their own copy of the wasm on import, so a single value import of the bare name (there were four in our own packages) used to cost each tab a second automerge instance and a second, byte-identical `automerge.wasm` download. The `/packages/@automerge/automerge.js` chunk is no longer emitted; the bare name points at `/packages/@automerge/automerge/slim.js`.

  `initWasm` in the host and the protocol-handler worker hand the wasm-bindgen init a `Request` instead of buffering the bytes first, so both automerge and subduction go through `WebAssembly.instantiateStreaming`: no 5 MB transient copy, and the compiled module is eligible for Chrome's code cache.

  `@inkandswitch/patchwork-bootloader/externals` and `/externals-list` export the alias table as `slim`.

  `pnpm lint` (scripts/lint-slim-imports.mts, run in CI) fails on any import of a bare name in the table, type-only ones included, so the fullfat entries stay out of every bundle.

- aa9af7e: The tab no longer heartbeats the automerge SharedWorker. The ping/pong, the second-connection probe, instance ids, and the recovery rate limit are gone: since every tab is its own Subduction node, the worker's control port carries only console forwarding, a debug toggle, and `connectClassicSync`, so a silent port strands nothing. The worker is respawned on the next `get()` if the browser terminates it (its control port fires `close`). `SharedWorkerHandle.onRecreated` is removed; it had no listeners. `@inkandswitch/patchwork` drops its page-lifecycle logging, which existed to line up against sync-socket reaps in a worker that no longer holds the tab's socket.
- Updated dependencies [7f54bd8]
- Updated dependencies [1cafc5e]
- Updated dependencies [f7d2e8c]
- Updated dependencies [32ed577]
- Updated dependencies [1d22480]
- Updated dependencies [aa9af7e]
- Updated dependencies [1d22480]
  - @inkandswitch/patchwork-bootloader@0.8.0
  - @inkandswitch/patchwork-elements@6.0.3
  - @inkandswitch/patchwork-plugins@1.2.6
  - @inkandswitch/patchwork-filesystem@0.2.10
  - @inkandswitch/patchwork-providers@0.5.3

## 0.8.2

### Patch Changes

- 483e23c: Bump @automerge/automerge to 3.5.0.
- Updated dependencies [483e23c]
  - @inkandswitch/patchwork-bootloader@0.7.2

## 0.8.1

### Patch Changes

- 5462610: Apply Patchwork's automerge-repo source patches at bundle time, so a site that installs `@inkandswitch/patchwork` gets them. They were only a pnpm patch, which exists in this repo's node_modules and nowhere else, so every consumer bundled an automerge-repo without the `mesh` subduction role or the `awaiting-reconnect` fix to `isConnecting()`.

  The new `patches` plugin is part of `patchwork()` and also exported on its own. It rewrites the two files as they pass through rollup, and registers the same rewrite as an esbuild plugin for dep pre-bundling, which runs outside the plugin pipeline. It is pinned to one automerge-repo version and every anchor has to match, so bumping the dependency fails the build rather than quietly dropping the patches. A copy that already carries the edits — this repo's, via the pnpm patch — is left alone.

- 5462610: Move keyhive out of `syncServers` and into its own top-level site option: `keyhive?: boolean | { syncServer?, useIdFactory? }`. `keyhive: true` enables it against the `"subduction"` relay; the object form picks a different relay (or a custom `{url, contactCardJson, peerId}` identity) and turns individual behaviour off. `keyhive.useIdFactory: false` drops the `idFactory` ARK injects into the repo config, so document ids are generated the Repo's own way instead of derived from keyhive. It reaches both the tab repo and the automerge protocol handler worker through the `__SYNC_SERVER__` define.

  `syncServers` is now just URLs — `subduction` and `classic`, no longer mutually exclusive with anything. Sites passing `syncServers: { keyhive: X }` should pass `keyhive: { syncServer: X }` instead; `syncServers.subduction` still overrides the URL a named relay implies.

- 5462610: Persist the Subduction signer so every context on an origin presents the same identity. The seed lives in the shared IndexedDB, so tabs and the automerge protocol handler worker adopt one signer instead of each minting a fresh `MemorySigner` on load. Generating it takes a Web Lock, so a cold profile opening two contexts at once still settles on one seed.

  `@inkandswitch/patchwork-bootloader/signer` is a new export: `loadOrCreateSigner(storage)` returns the origin's `MemorySigner`, generating and storing a seed the first time.

- Updated dependencies [5462610]
- Updated dependencies [5462610]
  - @inkandswitch/patchwork-bootloader@0.7.1

## 0.8.0

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
- Updated dependencies [2e71745]
  - @inkandswitch/patchwork-bootloader@0.7.0
  - @inkandswitch/patchwork-filesystem@0.2.9
  - @inkandswitch/patchwork-plugins@1.2.4

## 0.7.4

### Patch Changes

- 7339066: The dev importmap now names each builtin's pre-bundled dep URL
  (`/node_modules/.vite/deps/…?v=…`) instead of `/@id/<dep>`. Both URLs resolve to
  the same file, but a module fetched under two URLs is evaluated twice — the site
  imported solid through the pre-bundled URL and tool code imported it through the
  importmap, so tools ran against a second solid with its own owner stack and
  logged "computations created outside a `createRoot`" for every effect they
  created. Builtins that aren't pre-bundled still fall back to `/@id/<dep>`.
- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

- Updated dependencies [ebca53b]
- Updated dependencies [882eacd]
  - @inkandswitch/patchwork-bootloader@0.6.3
  - @inkandswitch/patchwork-elements@6.0.2
  - @inkandswitch/patchwork-filesystem@0.2.8
  - @inkandswitch/patchwork-plugins@1.2.3
  - @inkandswitch/patchwork-providers@0.5.2

## 0.7.3

### Patch Changes

- 8742cd2: Expose the individual vite plugins that `patchwork()` composes. Each one now has its own subpath — `@inkandswitch/patchwork/vite/importmap`, `/vite/service-worker`, `/vite/config`, `/vite/dev`, `/vite/icons`, `/vite/html`, `/vite/manifest`, `/vite/netlify`, `/vite/static`, `/vite/build-info` — and they are also re-exported from `@inkandswitch/patchwork/vite` as `importmap`, `serviceworker`, `config`, `dev`, `icons`, `html`, `manifest`, `netlify`, `statics` and `buildInfo`, so a site that wants its own composition can pick the pieces it needs instead of the whole default plugin array.
- Updated dependencies [94f6299]
- Updated dependencies [a96f250]
  - @inkandswitch/patchwork-elements@6.0.1
  - @inkandswitch/patchwork-plugins@1.2.1
  - @inkandswitch/patchwork-filesystem@0.2.6

## 0.7.2

### Patch Changes

- e1374ad: Serve the `/packages/…` builtin URLs in dev. Import maps don't apply to worker
  scripts, so code that starts one — `@automerge/automerge-repo`'s shared
  subduction websocket worker, for instance — asks for the `/packages/…` path the
  build emits. Nothing served those in dev, and the worker failed to fetch; the
  dev server now redirects them to the same optimized dep the page's import map
  points at.
- e1374ad: Say what's actually wrong when a `static` package declares a directory that
  isn't there. The package resolved fine — its `"patchwork": {"static": …}` field
  is what's wrong — and "static source not found" named neither the field nor the
  path it pointed at. The error now quotes the declaration, gives the full path
  that's missing, and says that a package publishing its static tree as the root
  of its own tarball shouldn't set the field at all.

## 0.7.1

### Patch Changes

- 8b9206d: Don't copy `static` sources or write `build-info.json` when a dev server shuts
  down. `closeBundle` runs then too, so stopping `vite` was filling `dist/` with
  a copy of every static source.

## 0.7.0

### Minor Changes

- 5be751b: Add `static` and `buildInfo` options to the vite plugin.

  `static` mounts file trees into the site — a package of Patchwork modules, a
  sibling repo's build output, a hand-written `modules.json`. Each source is
  served by the dev server and copied into the site at build:

  ```js
  patchwork({
    static: [
      { from: "modules.json" },
      "@inkandswitch/patchwork-pkg-base",
      {
        from: "../notebook/dist",
        to: "/packages/notebook",
        watch: ".watch-ready",
      },
    ],
  });
  ```

  A source is either a package specifier or a path relative to the site root, and
  either a file or a directory. `to` mounts it somewhere other than the site root.
  `watch` names a file inside the source that another build touches when it
  finishes; writing to it full-reloads the dev page, which is how a sibling repo
  in watch mode drives the site's dev server.

  Sources never overwrite the site's own files — not the build's output, not
  `public/`, not an earlier source in the list — so precedence is list order. A
  site that wants its own `modules.json` lists it before the package it takes the
  rest of its modules from. Every file a source didn't get to write is logged at
  the end of the build, so a collision you didn't mean to have is visible.

  A package can say which of its directories is the static tree with a
  `"patchwork": {"static": "static-dist"}` field in its package.json. Without one,
  the package root is mounted (minus its manifest, `node_modules` and `.git`).

  `buildInfo` writes `build-info.json`: the site's git revision, the version and
  revision of the patchwork that built it, and every `static` source. Pass an
  object to merge extra fields into it.

  Both options are off unless set, so existing sites are unaffected.

## 0.6.1

### Patch Changes

- f37bb8e: Bump `@automerge/automerge-subduction` to 0.16.1.
- Updated dependencies [f37bb8e]
  - @inkandswitch/patchwork-bootloader@0.6.2

## 0.6.0

### Minor Changes

- 61a152a: Add a `frameToolId` option to `setup`, and stop seeding a frame tool into new accounts.

  `createDefaultAccount` wrote `frameToolId: "threepane"` into every account it created — a tool id belonging to one particular tool bundle, hardcoded in core. A site whose `packageListURL` didn't ship `threepane` gave every new user an account pointing at a tool that never registers, so the root view never mounted.

  New accounts now leave `frameToolId` unset, and the router resolves the frame each boot:

  ```
  #frame=  →  the account's frameToolId  →  setup({frameToolId})  →  first tool tagged frame-tool
  ```

  The field is still written to the account when a user picks a frame, so it stays a user preference; it is no longer decided for them at signup. Existing accounts already have it set and are unaffected.

  Sites relying on the old seeded default should pass `frameToolId: "threepane"` to `setup`.

- 61a152a: Make `vite dev` work without a site hand-rolling the dev server.

  The build emits the service worker, the automerge shared worker, the module-loader worker, and three wasm binaries. None of them existed in serve mode, so every one 404'd and dev only worked if a site served a previous production build's `dist/` behind vite. The plugin now serves all of them itself:

  - The three worker entries are bundled on demand with esbuild and rebuilt per request, so they always reflect the source on disk. Their heavy imports resolve to the dev server's optimized-dep URLs, mirroring how the build rewrites them to `/packages/...` — import maps don't apply to `type: "module"` workers, so the URLs have to be real either way.
  - `automerge.wasm`, `keyhive_wasm.wasm`, and `subduction.wasm` are served from the bootloader's own node_modules. `@inkandswitch/patchwork-bootloader/externals` gains `wasmAssets()`, which `emitWasmAssets` now uses too.
  - `global.css` 404'd in dev: the generated `index.html` links it by bare specifier, which only the build resolves. Both patchwork's and the bootloader's stylesheets are now served under root-absolute paths, and the link points at them.
  - `@patchwork/service-worker` called `emitFile` from `buildStart` unconditionally, which throws in serve mode — it logged "This plugin is likely not vite-compatible" three times on every dev-server start. It now skips emission when serving.
  - Dep pre-bundling runs esbuild outside the plugin pipeline that applies `define`, so in dev the page fell back to the default storage prefix while the workers used the configured one — the two would have opened different IndexedDB databases. The defines are now passed to the optimizer as well.

  Sites no longer need to filter `@patchwork/service-worker` out of the plugin list, serve stylesheets themselves, or keep a built `dist/` around for `vite dev`.

### Patch Changes

- 846cfac: Update the pinned `@automerge/*` versions to `2.6.0-subduction.47`. These are exact pins in `dependencies` and `peerDependencies`, so both packages need to ship the new version together — installing a `.46` and a `.47` package side by side loads two copies of automerge-repo, and document handles from one are not recognised by the other.
- Updated dependencies [846cfac]
- Updated dependencies [61a152a]
  - @inkandswitch/patchwork-bootloader@0.6.1

## 0.5.0

### Minor Changes

- 98be594: Collapse `siteName`, `title`, and `setup({name})` into a single `title`.

  A site's name was three options across two files: `siteName` and `title` in the vite config, `name` at `setup`. They fed the same handful of strings and could disagree with each other.

  `title` is now the only one. It names the html `<title>`, `apple-mobile-web-app-title`, and the manifest's `name`/`short_name` as before, and is also emitted as the `__SITE_TITLE__` define, which supplies the brand word the router appends to the document title as `"<doc> | <title>"`. It defaults to `"Patchwork"`.

  - `siteName` and the `__SITE_NAME__` define are removed. If you used `siteName` only for display, rename it to `title`; if you relied on it to namespace storage, see `storagePrefix`.
  - `setup({name})` is now `setup({title})`, and is only needed to override the build-time value.

- 98be594: Namespace IndexedDB and peer ids with a new build-time `storagePrefix` option.

  The tab and the shared automerge worker are separate bundles that must open the same databases. Both now read the name from one place, `@inkandswitch/patchwork-bootloader/storage`, resolved from the `__STORAGE_PREFIX__` define the vite plugin emits unconditionally.

  Previously each side resolved `__SITE_NAME__` itself with a different fallback — `"patchwork.inkandswitch.com"` in the worker, `"patchwork"` in the tab — so a site that never set `siteName` had its tab and worker on two different keyhive databases, and one that passed `setup({name})` split them the same way, since a runtime option never reaches the worker.

  - `storagePrefix` defaults to `"patchwork"` and is settable only in the build config. Sites sharing an origin must use distinct prefixes. It is deliberately not derived from any display name: changing it points a site at empty storage, so a rebrand must not be able to change it by accident.
  - Sites that relied on `siteName` to namespace their storage must now set `storagePrefix` explicitly to that same value to keep their existing databases.
  - `createRepo` in `@inkandswitch/patchwork` no longer takes a site name argument.

### Patch Changes

- Updated dependencies [98be594]
  - @inkandswitch/patchwork-bootloader@0.6.0

## 0.4.0

### Minor Changes

- 776b9bb: Boot no longer waits on datatypes it doesn't own. `resolveAccountHandle` writes
  the account doc directly instead of blocking on `loadWhenReady("account")`, and
  `createDefaultAccount` builds the root folder, module-settings and anonymous
  contact subdocs itself rather than waiting for the `folder`,
  `patchwork:module-settings` and `contact` datatypes. A package bundle that never
  registers those no longer hangs setup until its timeout.

  `AccountDoc.frameToolId` is now optional. `createDefaultAccount` still writes
  `"threepane"`, and the router falls back to the first registered `frame-tool`
  when an account has none.

### Patch Changes

- Updated dependencies [776b9bb]
  - @inkandswitch/patchwork-plugins@1.2.0

## 0.3.3

### Patch Changes

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0
  - @inkandswitch/patchwork-elements@6.0.0
  - @inkandswitch/patchwork-bootloader@0.5.4

## 0.3.2

### Patch Changes

- 5fbc712: Prebundle development import-map dependencies so dynamically loaded packages share module singletons and receive Vite's CommonJS interop.

## 0.3.1

### Patch Changes

- 896fa22: Resolve built-in import-map packages through Vite during development so the site and dynamically loaded tools share module singletons.

## 0.3.0

### Minor Changes

- 9e6e0e0: Add a `createAccount` setup option, create required account subdocuments before exposing a fresh account, and stop exposing the account handle as `window.accountDocHandle`.

### Patch Changes

- Updated dependencies [9e6e0e0]
  - @inkandswitch/patchwork-plugins@1.1.0
  - @inkandswitch/patchwork-elements@5.0.0
  - @inkandswitch/patchwork-bootloader@0.5.3

## 0.2.1

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [f00dcb8]
  - @inkandswitch/patchwork-bootloader@0.5.2
  - @inkandswitch/patchwork-filesystem@0.2.5
  - @inkandswitch/patchwork-elements@4.0.4
  - @inkandswitch/patchwork-plugins@1.0.3

## 0.2.0

### Minor Changes

- 2fffabe: `setup()` now uses `packageListURL` as given instead of letting `localStorage.systemPackageListURL` silently replace it. A site that wants a dev override resolves it itself and passes the result in:

  ```ts
  const packageListURL =
    new URLSearchParams(location.search).get("system-package-list") ||
    localStorage.getItem("systemPackageListURL") ||
    DEFAULT_PACKAGE_LIST;
  ```

  This keeps the precedence in one place — the site — so a site can add its own override sources without fighting the library for priority.

### Patch Changes

- 6be3922: Wait for configured modules to load before routing the root view so registered frame tools are available for the initial route.
- 77bd37c: Expose the account document handle as `window.accountDocHandle` alongside `window.patchwork.account`.
- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [5f70c14]
  - @inkandswitch/patchwork-bootloader@0.5.1
  - @inkandswitch/patchwork-filesystem@0.2.4
  - @inkandswitch/patchwork-elements@4.0.3
  - @inkandswitch/patchwork-plugins@1.0.2

## 0.1.0

### Minor Changes

- 0aa315d: Configure Subduction or Keyhive with exclusive `syncServers` configuration. `syncServers.keyhive` replaces the `keyhive` and `keyhiveSyncServer` site options and the runtime `setup({ keyhive })` option. Selecting a named ARK relay or providing a custom relay identity and URL enables Keyhive, and configured server URLs now control worker connections as well as connection hints.
- bd63259: New package: one import for a Patchwork site. It owns the boot sequence (`repo`, `router`, `loading`), the vite plugin (config, html, importmap, manifest, netlify, icons, service worker), the site-kit config helpers, and the ambient client types — all previously spread across the bootloader and each site's own `index.html`, `vite.config.ts`, and `public/` directory.

  A site is now a `package.json` dependency, a `vite.config.ts` with `patchwork({...})`, and a `main.ts` that imports `@inkandswitch/patchwork`.

### Patch Changes

- Updated dependencies [0aa315d]
- Updated dependencies [bd63259]
- Updated dependencies [bd63259]
- Updated dependencies [bd63259]
  - @inkandswitch/patchwork-bootloader@0.5.0
  - @inkandswitch/patchwork-elements@4.0.2
  - @inkandswitch/patchwork-filesystem@0.2.3
