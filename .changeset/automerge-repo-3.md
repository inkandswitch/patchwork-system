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
---

Patchwork runs on automerge-repo 3.0.0-alpha.1 (`@automerge/automerge-repo-subduction` 3.0.0-alpha.1, `@automerge/subduction` 0.27.0), and talks to keyhive directly instead of through automerge-repo-keyhive.

**One node per origin.** automerge-repo 3 allows one live backend per IndexedDB database, so tabs no longer each run their own node on a shared database. The automerge SharedWorker holds the origin's one `SubductionBackend` (its IndexedDB, its socket to the sync server and, on keyhive sites, keyhive). Each tab's `Repo` runs on a `PortBackend`, a sedimentree backend that forwards to the worker over a MessagePort and carries on with each replacement worker. Tabs load only automerge's wasm. Documents are stored in new databases (`<prefix>-documents`, `<prefix>-hub`). Nothing is migrated from automerge-repo 2's database: documents come back from the sync server, and edits that never reached it stay in the old database.

**Keyhive, directly.** Keyhive (`@keyhive/keyhive` 0.6) lives only in the automerge worker. It syncs with the server over subduction's keyhive frames and encrypts and decrypts blobs as an encrypting backend around the worker's, the way pushwork's keyline does (pushwork#56). New documents get keyhive-minted ids in a group the sync server relays. Documents made public to Patchwork are read through Patchwork's public pair, as a second connection to the server in the same worker. Both keyhive server generations are still supported, picked by `keyhive.ark` as before (it defaults to `"0.6"` on subduction.sync.inkandswitch.com and to `"0.8"` elsewhere). `"0.8"` servers (staging, which serve `/keyhive/contact-card`) get keyline. `"0.6"` servers (prod) get ARK 0.6's keyhive sync and blob encryption (keyhive 0.3) from `@ark-0.6/automerge-repo-keyhive`, now loaded only in the automerge worker instead of swapping in a whole automerge-repo 2 stack. Each generation keeps its own keyhive state. Public documents are read through patchwork's public pair on 0.8 and through keyhive 0.3's world principal on 0.6. `keyhive.useIdFactory` is gone. Keyhive state from automerge-repo-keyhive isn't carried over, so a keyhive site starts with a new identity.

**Removed**

- bootloader: `connectClassicSync` (automerge-repo 3 has no classic sync), `connectPublicReader`, `publicReaderCanRead`, `onPublicReaderStatus`, and the `./signer`, `./keyhive-sync-server`, `./public-pair`, `./public-reader` and `./public-reader-worker` entry points. `storage.ts` no longer exports `keyhiveStorageName`, `keyhiveStorageVersion` or `publicReaderStorageName`.
- patchwork: `patchwork.sw.connectClassicSync`, `BootProgress.publicReader` and the `ark`/`arkAliases`/`arkStack` vite plugin exports. `HEADS_CHANNEL` is gone. `ArkVersion` is now exported from the bootloader too.
- elements: `setPublicAccess`, `publicAccessChanged` and `PublicAccess`. The worker's access check already counts public access.
- plugins: the `hive` argument to `createDocOfDatatype2` and `resolveAccountHandle`. New documents are minted into a group the sync server relays, so nothing is added after creating one.

**Changed**

- `window.hive`, `Patchwork.hive`, tool elements' `hive` and patchwork-view's `hive` are a `PatchworkHive` (exported by plugins): `{ id, canRead(url), canWrite(url), onChange(listener) }`, answered by the worker. Before, they were an automerge-repo-keyhive instance.
- `window.repo` is an automerge-repo 3 `Repo`. `create()`, `import()` and `clone()` return promises, `handle.change()` resolves once the change is stored, `handle.doc()` may be `undefined` for a sub-handle, and `whenReady()` is gone (handles from `find`/`create` are ready).
- `watchDocument(source, url, onChange)` takes `{ repo, backend? }`. The new `watchServerHeads(backend, documentId, onHeads)` reports a document's heads at the sync server without loading it. `patchwork.sw.subscribeSyncState` works for documents that aren't open, and its heads are subduction's hex commit ids.
- bootloader exports `PortBackend` and `connectToAutomergeWorker(backend)`, and `resolveHandoffsWith(repo, connected?)`.
- `isKeyhiveDoc` still tells keyhive-minted ids from automerge-repo 2's zero-padded 16-byte ones.
- The pnpm patch Patchwork applies to sites' bundles now targets `@automerge/automerge-repo-subduction`. It exposes the backend's native engine for keyhive sync, and starts a catch-up sync round when a single change is stored while a round for its document is in flight. Without that, a change made right after `create()` never reached the server.

**Providers.** Overlay repos and handles follow automerge-repo 3:

- `OverlayRepo.create()` (and `RepoLike.create()`) now returns `Promise<DocHandle>`, as the repo's does. `create2()` is gone: use `await create()`.
- `OverlayRepo` has `query(id)`, returning a `DocumentQuery` (`state()` and `subscribe()`, which calls back at once with the current state, with `loading`/`ready`/`unavailable`/`deleted`/`failed` statuses). `RepoLike` now requires `query`, which is what automerge-repo-react-hooks reads. `findWithProgress()` is deprecated, as the repo's is: it is now a progress-shaped view of `query` with an empty `sources`, and its deprecated `state`/`progress`/`error` getters are removed (use `peek()`).
- Overlay handles drop `getRemoteHeads()` and `isCaughtUpWith()`, which automerge-repo 3 removed; `getSyncInfo()` takes a `PeerId` rather than a `StorageId`. Use `handle.hasHeads()` in place of `containsHeads()`.
- `remote-heads` and `ephemeral-message` events carry `peerId` (no `storageId`), and reach every overlay handle on a document, as they do on the repo's handles. The `ephemeral-message-outbound` event is gone.
- The scratch repo is an in-memory `new Repo()`.

**Edge handles.** Awaits `repo.create()` and no longer calls `whenReady()` when creating and opening edge handles, following automerge-repo 3 where handles are always ready.
