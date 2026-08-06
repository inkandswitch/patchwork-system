# @inkandswitch/patchwork-providers-solid

## 0.2.7

### Patch Changes

- 6f4f62f: Depend on `solid-automerge` instead of `@automerge/automerge-repo-solid-primitives`. The Solid bindings are published under the new name; the peer dependency of `@inkandswitch/patchwork-providers-solid` moves to `solid-automerge` (`^2.0.1`). Install `solid-automerge` in place of `@automerge/automerge-repo-solid-primitives` — the exported API (`useDocument`, `createDocumentProjection`, `autoproduce`, …) is unchanged.
- Updated dependencies [6f4f62f]
  - @inkandswitch/patchwork-providers@0.5.1

## 0.2.6

### Patch Changes

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [2d39c84]
  - @inkandswitch/patchwork-providers@0.4.0

## 0.2.4

### Patch Changes

- 48e4391: Fix `subscribeDoc` corrupting the mirrored document on whole-value writes. It
  now reconciles the Solid store against the materialized `handle.doc()` snapshot
  on every change instead of replaying incremental patches via
  `createDocumentProjection`. Replaying the patch stream double-applied
  `putObjectFromHydrate` writes (e.g. `doc.list = [...]` yielded `[a, b, a, b]`);
  reconciling against the authoritative snapshot is robust to any valid change.
- Updated dependencies [48e4391]
  - @inkandswitch/patchwork-providers@0.3.0

## 0.2.3

### Patch Changes

- 78723b6: Allow Solid provider helpers to accept lazily resolved elements, so components can pass accessors that are evaluated on mount instead of requiring an `HTMLElement` up front.

## 0.2.2

### Patch Changes

- 5eafe78: Make `subscribe` preserve top-level provider emission identity by backing it with a Solid signal instead of a reconciled store. This makes subscription accessors work as expected when used as resource or memo sources, where consumers depend on the top-level value changing.

  Add `subscribeReconciled` for consumers that explicitly want store-backed behavior with `reconcile` for fine-grained nested updates. It accepts only JSON object or array roots and returns the Solid store directly.

- Updated dependencies [5eafe78]
  - @inkandswitch/patchwork-providers@0.2.2

## 0.2.1

### Patch Changes

- 68374f4: Make `subscribe` preserve top-level provider emission identity by backing it with a Solid signal instead of a reconciled store. This makes subscription accessors work as expected when used as resource or memo sources, where consumers depend on the top-level value changing.

  Add `subscribeReconciled` for consumers that explicitly want store-backed behavior with `reconcile` for fine-grained nested updates. It accepts only JSON object or array roots and returns the Solid store directly.

- Updated dependencies [68374f4]
  - @inkandswitch/patchwork-providers@0.2.1

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

### Patch Changes

- Updated dependencies [db46689]
  - @inkandswitch/patchwork-providers@0.2.0

## 0.1.3

### Patch Changes

- 0101e42: sync versions
- Updated dependencies [0101e42]
  - @inkandswitch/patchwork-providers@0.1.2

## 0.1.0

### Minor Changes

- 76db23e: Initial release. Solid bindings for the `@inkandswitch/patchwork-providers`
  request/respond protocol:
  - `request<T>(element, type, args?)` — dispatches a `patchwork:request` on
    mount and returns an `Accessor<T | undefined>` that updates when the
    provider responds.
  - `requestDoc<T>(element, type, args?)` — specialized variant for
    responses that resolve to a `DocHandle<T>`; returns
    `[doc, handle]` accessors backed by
    `@automerge/automerge-repo-solid-primitives`' `createDocumentProjection`.

### Patch Changes

- Updated dependencies [76db23e]
  - @inkandswitch/patchwork-providers@0.1.0
