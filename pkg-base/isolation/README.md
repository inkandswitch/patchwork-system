# @patchwork/isolation

Tool isolation as a **patchwork-base module** — sandboxed-iframe rendering of an
untrusted root component, gated by an allowlist/denylist intermediary repo.

This is a package-shaped port of the isolation design documented in
[`ISOLATION.md`](./ISOLATION.md) (vendored from patchwork-next core). The boot
sequence, bridges, and iframe bootstrap are copied from core largely verbatim;
what differs is how it is **delivered and driven**, because a patchwork-base
module cannot rely on the core bootloader and cannot be `import`ed by other
modules.

## Model: a `patchwork:component`, not a custom element

In core, isolation is a `<patchwork-isolation>` custom element registered by the
bootloader and driven imperatively via `element.configure(spec)`. That doesn't
work for a base module: modules have **no cross-`import` dependencies** — every
unit is resolved through the registry by id — and nothing registers a custom
element at boot.

So isolation ships as a single `patchwork:component` (id **`patchwork-isolation`**,
see `src/index.ts` → `src/component.ts`). A consumer mounts it purely by id:

```tsx
<patchwork-view
  component="patchwork-isolation"
  root-component="my-isolated-root" // patchwork:component the iframe mounts
  attr:automerge-allowlist={urls.join(",")} // seeds the sync allowlist (see note)
  shared-providers="patchwork:contact,patchwork:selected-doc,patchwork:worker-channel"
>
  <script type="application/json" data-patchwork-isolation>
    {JSON.stringify(props)}
  </script>{" "}
  {/* opaque root-component data, pushed live */}
</patchwork-view>
```

The config rides on the mounted element's DOM surface. It splits into two kinds
— **structural** (what the boundary _is_) and **opaque cargo** (data for the
root that the boundary never interprets):

| config                       | carried as                                        | change behavior     |
| ---------------------------- | ------------------------------------------------- | ------------------- |
| `rootComponentId`            | `root-component` attribute                        | **reboot**          |
| `rootUrls`                   | `automerge-allowlist` attribute (comma-separated) | **reboot**          |
| bridged providers            | `shared-providers` attribute                      | **reboot**          |
| root-component data (opaque) | inert `<script data-patchwork-isolation>` child   | **push, no reboot** |

**Structural attributes → reboot.** `patchwork-view` only re-syncs a component on
`component`/`url` changes (the three structural attributes aren't in its
`observedAttributes` at all), so the mount fn (`component.ts`) self-observes them
with a `MutationObserver` and reboots the iframe (microtask-debounced) when one
changes — they change which root mounts, the sync allowlist, or the bridged set,
so a fresh boot is required. (This observer watches _attributes only_, never the
element subtree: the iframe is appended as a child of this element, so a subtree
observer would retrigger on the iframe's own churn and loop. It lives in the
mount fn rather than `bootIsolation` because it _triggers_ reboots and so must
outlive any single boot.)

**Root-component data → opaque cargo, pushed live.** The boundary treats the data
`<script>` (marked `data-patchwork-isolation`, looked up as a direct child via
`:scope >`) as an opaque string: it never parses it, only relays its text. It
rides the boot message on first mount, and `bootIsolation` installs a
`MutationObserver` — scoped to that `<script>` node's text specifically — that
pushes later changes to the _running_ iframe via a `root-component-data-update`
RPC message with **no reboot**. (This observer lives inside `bootIsolation`: its
lifetime is exactly one boot, so it is torn down with the rest. The iframe side
lives in `boot/iframe/root-component-data.ts`.) The iframe writes the new text
into the root's own
`<script>`, and the in-iframe root re-reads it reactively. Note doc-bearing props
(selected doc, tray/context slot docs) are also in `automerge-allowlist`, so
switching documents still reboots (the allowlist must re-seed); a same-document
props tweak (collapse toggle, tool reorder) updates in place.

> **`attr:automerge-allowlist`, not `automerge-allowlist`, for the dynamic
> value.** In a Solid consumer, a _dynamic_ `automerge-allowlist={...}` compiles
> to a DOM _property_ assignment, which `getAttribute` (and the MutationObserver)
> would never see. The `attr:` namespace forces a real attribute. Static string
> literals (`root-component`, `shared-providers`) are baked into the template as
> attributes already and need no prefix — only dynamic bindings do.

## Build

- `pnpm build` runs `generate:esms` (prebuild) then `vite build`.
- **es-module-shims is bundled as a source string** (`src/esms-source.generated.ts`,
  produced from the `es-module-shims/wasm` variant core serves). The opaque-origin
  iframe can't fetch it, and a base module can't assume a host-served
  `/es-module-shims.js`.
- **`automerge.wasm` / `subduction.wasm` are still fetched from the host origin** —
  a stable platform contract every patchwork tool relies on.
- Built with `target: esnext`, `minify: false`, and `@automerge/*` +
  `@inkandswitch/patchwork-*` externalized (resolved through the host import map).
  This keeps the `src/boot/iframe/*` functions — which are delivered into the
  iframe via `.toString()` (see `boot/host/srcdoc.ts`) — self-contained, with no
  bundler-injected helpers that would break stringification.

**Version lockstep:** the iframe `importShim`s bare `@automerge/*` /
`patchwork-*` specifiers through the host import map, so this package's declared
versions must match what the host serves (i.e. the other base modules'
versions). Keep `package.json` in step with `threepane/package.json`.

## Registration

Like every patchwork module, this is published/registered independently (not a
dependency of its consumers):

```
pnpm build
pushwork sync
pw-modules add "$MODULE_SETTINGS_DOC_URL" "$(pushwork url)"
```

Consumers (e.g. threepane) then reach it only by the id string
`"patchwork-isolation"`.

## Design doc

The full threat model and architecture live in [`ISOLATION.md`](./ISOLATION.md)
(vendored from patchwork-next core alongside the source). The security
mechanisms — the sandboxed iframe, allowlist/denylist intermediary repo,
`registry--` marker scheme, providers bridge — are identical here.

> **Note:** `ISOLATION.md` has **not** been updated for the custom-element →
> component migration. It still describes the core `<patchwork-isolation>`
> custom element and its imperative `configure(spec)` API. In this package that
> is replaced by the `patchwork-isolation` **component** driven by DOM
> attributes + a root-component-data `<script>` child (see [Model](#model-a-patchworkcomponent-not-a-custom-element)
> above). Everything else in the doc — the boundary design and its guarantees —
> still applies unchanged.

## Relationship to core

No patchwork-next core changes. Core keeps its custom-element implementation;
this is an independent vendored, component-shaped copy.

### Provenance of the vendored source

The `src/boot/` and `src/bridges/` trees are copied from core's
`core/elements/src/isolation/`. As of the migration:

- **Identical to core (vendored verbatim):** all of `boot/host/*` (except
  `assets.ts` and `boot.ts`), all of `boot/iframe/*` (except `main.ts`),
  `boot/index.ts`, all of `bridges/*`, `log.ts`. The security-relevant bridge
  logic is untouched.
- **Changed from core:**
  - `boot/host/assets.ts` — es-module-shims is bundled as a string
    (`esms-source.generated.ts`) instead of `fetch("/es-module-shims.js")`; the
    two WASM fetches are unchanged.
  - `index.ts` — rewritten from core's element exports
    (`registerPatchworkIsolationElement`) to the `plugins` array exposing the
    `patchwork:component`.
  - `boot/host/boot.ts`, `boot/iframe/main.ts` — **element-driven config +
    root-component-data-as-opaque-payload + live update.** Core hands
    `bootIsolation` a computed `IsolationBootSpec` object (with `props` as a
    structured-clone object it re-serializes in the iframe). Here the mounted
    element IS the config: `bootIsolation(host)` reads its config off `host` (via
    `boot/host/config.ts`) and installs the data-`<script>` observer that streams
    changes to the running iframe via a `root-component-data-update` RPC message
    (no reboot); `main.ts` delegates the iframe side to the
    `root-component-data.ts` helper. (See
    [Model](#model-a-patchworkcomponent-not-a-custom-element).)
- **Not carried over from core:** `patchwork-isolation.ts` (the custom-element
  shell — replaced by the component model), `boot/host/spec.ts` +
  `types.ts`'s `IsolationBootSpec` (the spec object is gone — config is read off
  the element), and core's `README.md` (vendored here as
  [`ISOLATION.md`](./ISOLATION.md) instead).
- **Package-only additions:** `component.ts` (the `patchwork:component` mount fn +
  the structural-attribute reboot observer), `boot/host/config.ts` (the
  element-config readers — the data-marker lookup, allowlist/root-component
  attrs), `boot/iframe/root-component-data.ts` (the iframe-side data `<script>`
  manager — mount + live-update handler), and `esms-source.generated.ts`
  (generated, gitignored).

Keep the verbatim files in sync with core when the boundary logic changes there.
The changed files have diverged intentionally; re-vendoring them from core would
undo the component model and the opaque-data/live-update behavior.
