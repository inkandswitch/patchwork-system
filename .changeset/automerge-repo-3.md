---
"@inkandswitch/patchwork-bootloader": minor
"@inkandswitch/patchwork": minor
"@inkandswitch/patchwork-plugins": minor
"@inkandswitch/patchwork-elements": minor
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-providers": minor
"@inkandswitch/patchwork-providers-react": patch
"@inkandswitch/patchwork-providers-solid": patch
"@inkandswitch/edge-handles": patch
"@inkandswitch/patchwork-e2e": patch
---

Patchwork runs on automerge-repo 3.0.0-alpha.1 (`@automerge/automerge-repo-subduction` 3.0.0-alpha.1, `@automerge/subduction` 0.27.0), and no longer uses keyhive.

**One node per origin.** automerge-repo 3 allows one live backend per IndexedDB database, so tabs no longer each run their own node on a shared database. The automerge SharedWorker holds the origin's one `SubductionBackend` (its IndexedDB and its socket to the sync server). Each tab's `Repo` runs on a `PortBackend`, a sedimentree backend that forwards to the worker over a MessagePort and carries on with each replacement worker. Tabs load only automerge's wasm. Documents are stored in new databases (`<prefix>-documents`, `<prefix>-hub`). Nothing is migrated from automerge-repo 2's database: documents come back from the sync server, and edits that never reached it stay in the old database.

**No keyhive.** Keyhive is gone: documents are stored and synced in the clear over subduction, and every site runs the same plain subduction repo. The access checks views made before mounting, and the `@keyhive/keyhive` and `@automerge/automerge-repo-keyhive` dependencies (and the keyhive wasm and importmap entries a build emitted), are removed. Keyhive state from automerge-repo-keyhive is left where it was, unread.

The keyhive API is kept, deprecated and inert, so nothing that imports it breaks: `isKeyhiveDoc` always returns false; `PatchworkHive`, `ArkVersion` and `PatchworkKeyhiveOptions` are still exported; the `keyhive` site option and the `hive` options of `setup()` and `registerPatchworkViewElement` are accepted and ignored; `window.hive`, `Patchwork.hive`, `ToolElement.hive` and patchwork-view's `hive` are never set; `hasActiveAccess(hive, url)` still asks the hive it's given; `PortBackend.onHiveChange` never calls back, the worker's `info()` reports `hive: null`, and it refuses `hive` calls.

**Removed**

- bootloader: `connectClassicSync` (automerge-repo 3 has no classic sync), the `@keyhive/keyhive` importmap entries, `KEYHIVE_WASM` from `./emitted`, `connectPublicReader`, `publicReaderCanRead`, `onPublicReaderStatus`, and the `./signer`, `./keyhive-sync-server`, `./public-pair`, `./public-reader` and `./public-reader-worker` entry points. `storage.ts` no longer exports `keyhiveStorageName`, `keyhiveStorageVersion` or `publicReaderStorageName`.
- patchwork: `patchwork.sw.connectClassicSync`, `BootProgress.publicReader` and the `ark`/`arkAliases`/`arkStack` vite plugin exports. `HEADS_CHANNEL` is gone.
- elements: `setPublicAccess`, `publicAccessChanged` and `PublicAccess`.
- plugins: the `hive` argument to `createDocOfDatatype2` and `resolveAccountHandle`.

**Changed**

- `window.repo` is an automerge-repo 3 `Repo`. `create()`, `import()` and `clone()` return promises, `handle.change()` resolves once the change is stored, `handle.doc()` may be `undefined` for a sub-handle, and `whenReady()` is gone (handles from `find`/`create` are ready).
- `watchDocument(source, url, onChange)` takes `{ repo, backend? }`. The new `watchServerHeads(backend, documentId, onHeads)` reports a document's heads at the sync server without loading it. `patchwork.sw.subscribeSyncState` works for documents that aren't open, and its heads are subduction's hex commit ids.
- bootloader exports `PortBackend` and `connectToAutomergeWorker(backend)`, and `resolveHandoffsWith(repo, connected?)`.
- The pnpm patch Patchwork applies to sites' bundles now targets `@automerge/automerge-repo-subduction`. It exposes the backend's native engine (the worker asks it for its connected peers), and starts a catch-up sync round when a single change is stored while a round for its document is in flight. Without that, a change made right after `create()` never reached the server.

**Providers.** Overlay repos and handles follow automerge-repo 3:

- `OverlayRepo.create()` (and `RepoLike.create()`) now returns `Promise<DocHandle>`, as the repo's does. `create2()` is gone: use `await create()`.
- `OverlayRepo` has `query(id)`, returning a `DocumentQuery` (`state()` and `subscribe()`, which calls back at once with the current state, with `loading`/`ready`/`unavailable`/`deleted`/`failed` statuses). `RepoLike` now requires `query`, which is what automerge-repo-react-hooks reads. `findWithProgress()` is deprecated, as the repo's is: it is now a progress-shaped view of `query` with an empty `sources`, and its deprecated `state`/`progress`/`error` getters are removed (use `peek()`).
- Overlay handles drop `getRemoteHeads()` and `isCaughtUpWith()`, which automerge-repo 3 removed; `getSyncInfo()` takes a `PeerId` rather than a `StorageId`. Use `handle.hasHeads()` in place of `containsHeads()`.
- `remote-heads` and `ephemeral-message` events carry `peerId` (no `storageId`), and reach every overlay handle on a document, as they do on the repo's handles. The `ephemeral-message-outbound` event is gone.
- The scratch repo is an in-memory `new Repo()`.

**Edge handles.** Awaits `repo.create()` and no longer calls `whenReady()` when creating and opening edge handles, following automerge-repo 3 where handles are always ready.

**e2e.** The suite's helpers await `repo.create()` and `handle.change()`, which automerge-repo 3 made async.
