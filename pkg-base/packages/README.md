# Packages

A visualizer for the **live** `@inkandswitch/patchwork-plugins` registries.

Unlike the Module Settings Manager — which is a view of *your* module-settings doc
(the list of automerge URLs you've installed) — this tool renders the **actual
in-memory registries** the host has populated (`getAllRegistries()`). Because the
importmap resolves `@inkandswitch/patchwork-plugins` to the host's singleton, what
you see here is the real, running registry state, updating live as plugins are
registered, loaded, or shadowed.

It still takes a **module-settings doc** as its handle, but only to say where each
plugin came from: it reads `doc.modules` and cross-references each plugin's `importUrl`.

## Three ways to look at it

- **By package** — grouped by `importUrl`, each group named by the `package.json` at
  that source (`title` → `name` → a URL-derived fallback), with its version and the
  plugins it contributes.
- **By type** — grouped by registry, since a registry is a plugin type:
  `patchwork:tool`, `patchwork:datatype`, `patchwork:component`, `patchwork:theme`,
  `codemirror:extension`, and any others minted at runtime.
- **Table** — a flat, sortable list (name / registry / id / package / origin / unlisted / importUrl).

Plus: a filter box (matches name, id, type, package, importUrl, supported
datatypes, "unlisted") and origin chips with counts. Pasting an `automerge:` or
`https://` URL into the filter box opens the install modal instead; typing one
just filters.

## Origin

Provenance is inferred from `importUrl` (the registry has no "core" flag). The
badge text comes from `ORIGIN_LABEL` in `src/origin.ts`:

| badge | origin | meaning |
|---|---|---|
| **my package list** | `installed` | its module is listed in the settings doc you're viewing |
| **system package list** | `core` | listed in one of the host's other settings sources (the site's default bundle), or a plain `http(s)://` / bare specifier |
| **ephemeral** | `ephemeral` | an `automerge:` module in neither list — loaded this session (a suggested import, a share) and gone after reload unless you install it |
| **unknown** | `unknown` | no `importUrl` at all |

Automerge URLs are compared by documentId, so a heads-pinned `importUrl` still
matches the bare URL in `modules[]`.

Every plugin shows its `importUrl` (click to copy) and, for automerge sources, the
heads it's at; automerge sources get an **open** button, and anything in your list
gets **delete**. Modules in your list that registered nothing and fail to import
show as red boxes with the error (in the By package view).

## Build & publish

Bundled Solid tool (vite). `@inkandswitch/patchwork-plugins` is left **external** so
it resolves to the host's live singleton — don't bundle it.

```sh
pnpm install
pnpm build          # or: ./node_modules/.bin/vite build
pushwork sync       # publish; prints the automerge: URL to install
```

Then **install** the printed URL in your module-settings doc (the Module Settings
Manager's "Install" field, or `pw-modules add <settings-doc-url> <tool-url>`) so the
tool id `packages` resolves.

The host's account-bar "Packages" link has been pointed at this tool
(`toolId: "packages"`) in `base/threepane/src/PatchworkFrame.tsx` and
`base/sideboard/src/sideboard/account-bar.tsx`; rebuild base for that to take effect.

## Tests

`pnpm test` runs vitest (`src/*.test.ts[x]`): the origin/URL helpers, package
naming, http plugin discovery, and the filter box's paste-vs-type behaviour.

## Files

- `src/index.tsx` — worker-safe entry: metadata + `load()` only (no static externals).
- `src/mount.tsx` — the `(handle, element) => cleanup` render contract.
- `src/packages.tsx` — the tool: toolbar, view switch, notices, install modal slot.
- `src/use-package-data.ts` — the viewed doc, live registries, settings sources, heads, package.json meta → enriched entries.
- `src/use-broken-modules.ts` — modules in your list that registered nothing, probed for an import error.
- `src/model.ts` — view types and pure filter / group / sort functions.
- `src/views.tsx` — By package, By type, Table.
- `src/broken-modules.tsx` — the failed-import boxes.
- `src/install-modal.tsx` — install a package, with a preview.
- `src/bits.tsx` — badges, click-to-copy, plugin rows, source line and actions.
- `src/registry.ts` — live snapshot of `getAllRegistries()` + subscriptions, and deactivation.
- `src/origin.ts` — URL helpers and installed / core / ephemeral classification.
- `src/settings-sources.ts` — the host's module-settings sources (`window.patchwork.packages`).
- `src/doc-heads.ts` — live heads per automerge module.
- `src/pkg-meta.ts` — package.json name/version resolution per importUrl.
- `src/discover-plugins.ts` — read a package's plugin list without registering it.
