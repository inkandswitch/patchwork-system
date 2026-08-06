# @inkandswitch/patchwork-providers

## 0.5.1

### Patch Changes

- 6f4f62f: Depend on `solid-automerge` instead of `@automerge/automerge-repo-solid-primitives`. The Solid bindings are published under the new name; the peer dependency of `@inkandswitch/patchwork-providers-solid` moves to `solid-automerge` (`^2.0.1`). Install `solid-automerge` in place of `@automerge/automerge-repo-solid-primitives` — the exported API (`useDocument`, `createDocumentProjection`, `autoproduce`, …) is unchanged.

## 0.5.0

### Minor Changes

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

## 0.4.2

### Patch Changes

- c01e1f3: Give `<patchwork-view>` a proper exports map and test suite, and tear down its overlay repo on unmount.

  Add `registerPatchworkViewTag` so views registered under a custom tag name are still treated as subscription boundaries, and `OverlayRepo.dispose()`/`OverlayHandle.dispose()` so unmounting a view detaches the event forwarders it installed on backing handles.

## 0.4.1

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

## 0.4.0

### Minor Changes

- 2d39c84: `accept`'s `respond` callback now takes an optional `Transferable[]` second argument, forwarded to `MessagePort.postMessage` so a provider can transfer objects (e.g. a `MessagePort` or `ArrayBuffer`) to the consumer instead of structured-cloning them.

## 0.3.0

### Minor Changes

- 48e4391: Add an `OverlayRepo` layer so document resolution can be remapped across
  provider scopes (e.g. to a draft/branch clone) without sending a live `Repo` or
  `DocHandle` over the provider boundary.
  - `OverlayRepo` is a realm-local `RepoLike` shim whose `find` /
    `findWithProgress` dispatch a `repo:handle-descriptor` subscription, resolve the
    returned `cloneUrl ?? url` against the realm-local base repo, and hand back an
    `OverlayHandle`. Every other method forwards to the base repo unchanged.
  - `OverlayHandle` is a url-hiding proxy around a fixed backing `DocHandle`:
    `url` / `documentId` keep reporting the originally requested url, all other
    operations forward to the backing (clone) handle, and forwarded events are
    re-stamped so consumers never observe the backing handle.
  - A remapper answers the `repo:handle-descriptor` subscription with a
    `DocHandleDescriptor` (`{ url, cloneUrl? }`) — plain, structured-cloneable
    data, never a live handle.
  - `<repo-provider>` now acts as the root-level fallback answerer for
    `repo:handle-descriptor`, resolving a requested url to itself (no clone) so a
    view rendered outside any remapper still resolves and the overlay's `find`
    never hangs.

  New exports: `OverlayRepo`, `OverlayHandle`, `DocHandleDescriptor`, and
  `OverlayHandleOpts`.

## 0.2.2

### Patch Changes

- 5eafe78: Constrain subscription channel values to JSON-serializable data so provider emissions match the structured-clone boundary used by `patchwork:subscribe`.

  Export shared `JSONValue`, `JSONObject`, and `JSONArray` types for framework adapters and provider consumers.

## 0.2.1

### Patch Changes

- 68374f4: Constrain subscription channel values to JSON-serializable data so provider emissions match the structured-clone boundary used by `patchwork:subscribe`.

  Export shared `JSONValue`, `JSONObject`, and `JSONArray` types for framework adapters and provider consumers.

## 0.2.0

### Minor Changes

- db46689: Unify everything on the streaming `subscribe`/`accept` protocol and remove the
  one-shot `request`/`provide` event machinery.
  - A consumer calls `subscribe(element, selector, listener)` and gets back an
    unsubscribe function; a provider answers with `accept(event, (respond) =>
teardown)` and can push values via `respond` for as long as the subscription
    is live. Subscriptions are keyed on a `Selector` — a JSON object that always
    carries a `type` discriminant plus any subscription-specific fields (e.g.
    `{ type: "patchwork:comments", url }`), so it survives the structured clone
    across the `patchwork:subscribe` event boundary.
  - `request(element, selector)` is now a thin convenience wrapper over
    `subscribe`: it resolves with the first emitted value and immediately
    unsubscribes. `provide`, the `patchwork:request`/`patchwork:response` events
    and their detail types have been removed.
  - The `<fallback-provider>` element is gone. Unclaimed selectors are simply
    never answered (no `null` settlement), so `request` for an unanswered
    selector never resolves — use `subscribe` if you need to handle "no
    provider".
  - Values cross the channel structured-cloned, so `DocHandle`s and `Repo`s can
    no longer be sent. The repo is published as a global (`globalThis.repo`) and
    read back via the new `getRepo()` helper; providers emit an `AutomergeUrl`
    and consumers recover the live `DocHandle` locally.

  The Solid bindings gain `subscribe(element, selector, initialValue?)` (backed
  by a store + `reconcile`) and `subscribeDoc(element, selector)` which recovers
  `[doc, handle]` from the global repo. The React bindings gain matching
  `useSubscribe` and `useSubscribeDoc` hooks. The old `requestDoc` /
  `useDocRequest` handle-request helpers are replaced by these.

## 0.1.2

### Patch Changes

- 0101e42: sync versions

## 0.1.0

### Minor Changes

- 76db23e: Initial release. Adds a small DOM-event based request/respond protocol for
  Patchwork providers:
  - `request(element, type, args?)` / `provide(event, value)` helpers that
    dispatch `patchwork:request` and listen for `patchwork:response` along
    the DOM tree.
  - `<repo-provider>` custom element (`registerRepoProviderElement`) that
    exposes an `automerge-repo` `Repo` and resolves `getRepo` / `findDocument`
    requests from descendant elements.
  - `<fallback-provider>` custom element (`registerFallbackProviderElement`)
    that answers any unhandled request with `null` so consumers can rely on
    a terminating response.
  - `RepoLike` type for embedders that want to back the provider with a
    custom repo-shaped object.
