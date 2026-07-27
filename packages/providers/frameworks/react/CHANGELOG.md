# @inkandswitch/patchwork-providers-react

## 0.2.5

### Patch Changes

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [2d39c84]
  - @inkandswitch/patchwork-providers@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [48e4391]
  - @inkandswitch/patchwork-providers@0.3.0

## 0.2.2

### Patch Changes

- 5eafe78: Constrain `useRequest` and `useSubscribe` provider values to JSON-serializable data, matching the core provider subscription channel.
- Updated dependencies [5eafe78]
  - @inkandswitch/patchwork-providers@0.2.2

## 0.2.1

### Patch Changes

- 68374f4: Constrain `useRequest` and `useSubscribe` provider values to JSON-serializable data, matching the core provider subscription channel.
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

- 76db23e: Initial release. React bindings for the `@inkandswitch/patchwork-providers`
  request/respond protocol:
  - `useRequest<T>(element, type, args?)` — dispatches a `patchwork:request`
    on mount and returns the provider's response as state.
  - `useDocRequest<T>(element, type, args?)` — specialized variant for
    responses that resolve to a `DocHandle<T>`; returns `[doc, handle]`
    matching `useDocument` from `@automerge/automerge-repo-react-hooks`.

### Patch Changes

- Updated dependencies [76db23e]
  - @inkandswitch/patchwork-providers@0.1.0
