# Patchwork

House style: small, simple tools in plain vanilla JavaScript. TypeScript,
npm deps, and a bundled build are all fine (pushwork handles them). If a
reactive framework is needed, use Solid — never React.

## Every folder is a separate tool

This repo is a collection, not a project. Each top-level directory with a
`package.json` is an independent package: its own dependencies, its own
`pnpm-lock.yaml`, its own `node_modules`, its own `pnpm-workspace.yaml` for
pnpm settings, its own build system. Some use esbuild, some use vite, some
have no build at all. Some are Solid, some are React, some are vanilla.

There is **no workspace and no lockfile at the repo root**. Nothing installs
there. `pnpm -r` has nothing to recurse over. To do something in every tool,
use `node scripts/each.mjs <script>` (`pnpm each install`, `pnpm test`).

You should be able to copy any one of these folders out of the repo, run
`pnpm install && pnpm build` inside it, and get the same result you get here.

### What that rules out

- No `workspace:`, `catalog:`, `link:` or `file:` dependency specifiers.
- No importing another tool's source, or reaching into its `dist/`.
- No assuming a sibling has been installed or built first — installs and
  builds run in arbitrary order and in parallel.
- No shared root config for tools to inherit.

`node scripts/lint-standalone.mjs` (`pnpm lint`) fails the build on any of
these, and on a `pnpm-workspace.yaml` at the root, and on a root
`pnpm-lock.yaml` that either resolves any package or is committed. (Running a
root script leaves an empty lockfile behind; it's gitignored and inert, so it's
tolerated on disk and nowhere else.) CI runs it on every PR.

## Making a new tool

A new top-level folder is a new package, so it needs everything a package
needs. `pnpm lint` checks the last three; the rest will just be wrong quietly.

1. **`package.json`** — deps at published registry versions only. Add a
   `"test": "vitest run"` script and `"test:watch": "vitest"`.
2. **`vitest.config.ts`** — copy a neighbour's. Keep `passWithNoTests: true`,
   so a tool with no tests yet still reports green. Match the framework:
   `vite-plugin-solid` for Solid, `@vitejs/plugin-react` for React, no plugin
   for vanilla.
3. **`pnpm-workspace.yaml`** — copy a neighbour's verbatim. It is not a
   workspace; it is only where pnpm 11 reads its settings, and without it the
   package hits the release-age cooldown and pnpm's blocked build scripts. This
   file must be **committed**.
4. **`pnpm-lock.yaml`** — run `pnpm install` in the folder and **commit it**.
5. **`.gitignore`** — `dist`, `node_modules`, `.pushwork`. Do **not** ignore
   `pnpm-lock.yaml` or `pnpm-workspace.yaml`. That mistake is invisible on the
   machine that made it and only shows up in a fresh clone, which is why the
   linter checks for it.

The same applies to a package nested inside another one (there is one:
`tasks/src/in-the-cloud`) — the linter walks those too.

Then check the actual claim: copy the folder somewhere else on its own, and
`pnpm install && pnpm build && pnpm test` in the copy.

### When two tools want the same code

Make them one package. A package can register as many plugins as it likes, so
several tools and datatypes can ship from one folder and share a module
directly — that's what `account/` is (the contact datatype and its views, plus
the account picker, sharing one colour palette). Copying the code is the other
acceptable answer. Linking them is not.

Tools may still depend on each other at *runtime* through the plugin registry —
by tool id, datatype id, or a `<patchwork-view tool-id="...">`. That's a
late-bound lookup that degrades to nothing if the other tool isn't installed,
which is fine. A build-time dependency is not.

## Testing

Every tool has a `test` script (`vitest run`) and a `vitest.config.ts`, set to
`passWithNoTests` so a tool without tests still reports green. `pnpm test` at
the root runs them all.

## Reference tools in this repo

The skill's patterns map to these tools — copy from the category you need:

**Copy these patterns (vanilla JS):**

- **Bundleless / vanilla:** `tic-tac-toe`, `catclock`, `walkies`, `sparkles`, `webtile`
  (`tic-tac-toe/tic-tac-toe.js` also shows documenting the schema with a JSDoc `@typedef`)
- **Web Components + audio/wasm:** `bento`, `call`, `sound`
- **Headless actions:** `actions` (written in TypeScript)

**Reach for Solid if you need reactivity:** `cache-browser`, `file`, `chat`, `paper` (these use
JSX + a bundle; `solid-js/html` is a bundleless alternative).

**Legacy React — reference for behavior, NOT for style (don't copy the React approach):**
`datagrid`, `boardgame`, `datalog`, `doc-copy-history`.

- **Multi-plugin packages** (one package registering several plugins): `file/src/index.ts`
  (file + new-file datatypes), `bento/main.js` (datatype + tool)
- **Richer datatypes** (type guards, content getters): `file/src/datatype.ts`
- **Collaborative text** (`@automerge/automerge-codemirror` + cursors): `file`, `call`, `datalog`
- **CodeMirror extension:** `codemirror-latex`, `file`
- **Whole-folder / inspector (`supportedDatatypes: ["*"]`):** `inspector`, `cache-browser`,
  `breadboard`, `doc-copy-history`
