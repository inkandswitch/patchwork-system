# Package-supplied path providers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A datatype package can register a `patchwork:path-provider` plugin that says what a document of its type contains. Tabs walk paths through it. The sidebar opens those documents up, offers whatever editing the provider offers, and opens sub-document children as automerge sub-handles.

**Architecture:** This spans two repos.
- **system** (`paths-design`):
  - `patchwork-filesystem` gains the optional editing methods and the `sub` child on `PathProvider`. Walks take extra providers as an option, checked after the built-ins.
  - `patchwork-plugins` owns the plugin type, and `pathProviderFor(doc)`: built-ins first, then plugins. filesystem can't import plugins, since plugins depends on filesystem.
  - The tab resolver and the router pass plugin providers into their walks. The automerge worker passes none.
- **base** (`paths`): the sidebar finds providers through the host's `patchwork-plugins` (an importmap external), feature-detected. On an older host it behaves as it does now.

**Tech stack:** TypeScript, automerge-repo 2.6 sub-handles (`handle.sub(...segments)`; `repo.find` of `automerge:<id>/<path>` returns the sub-handle), vitest, Solid + happy-dom in base.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, section 6.

## Global Constraints

- Built-ins (account, directory, folder, branches) are checked first and can't be overridden. Package providers come after, in registration order.
- A provider is a pure function of the node it's given: `list` and `lookup` read nothing else.
- Package providers run in tabs only. Nothing on the automerge worker's path imports `patchwork-plugins` provider code or passes `providers`.
- `/packages` stays the worker's. Tabs already decline it, so no change is needed there.
- The sidebar enables only the editing a provider offers. A child of a provider that offers none is read-only.
- A changeset for every published package touched (filesystem, plugins, bootloader, patchwork). `patch` level.

## Decisions

1. **`supportedDatatypes: string[]`**, with no `"*"`. A provider that claims every type would be asked about every document the sidebar shows. `"*"` is ignored, with a warning.
2. **Sub-document segments are relative to the node passed to `lookup`/`list`.** A walk accumulates them across consecutive `sub` steps. A plain `value` step ends the chain: what's below it isn't openable as a sub-document.
3. **Sidebar drops into a provider container link, never move.** A document dropped on a row whose provider offers `add` calls `add(handle, doc, { name, link })`. Its source is left alone, as in copy mode. File drops and new-document drops aren't accepted there; this first cut doesn't try to map folder semantics onto arbitrary providers.
4. **The folder provider gets no editing methods yet.** The spec says it *would* offer all three, and that there's no need to move folder editing yet.
5. **A loaded provider is checked for shape.** `matches`, `lookup` and `list` must be functions; one that isn't is skipped, with a warning. So is one that fails to load.

## Review Focus

1. **A plugin that registers after the sidebar has rendered.** A row of its type should become expandable without a reload. Test: B1 `canExpand` follows the registry's `"changed"` event.
2. **A provider that throws in `list` or `lookup`.** The walk or listing treats that document as having no children; it doesn't fail the page. Test: S1 `walkPath` with a throwing provider returns undefined, and B2 renders no children.
3. **A sub child whose segments don't resolve** (the value was deleted). The walk returns undefined, and the sidebar hides the row. Test: S1.
4. **Automerge worker isolation.** The worker's resolver must never consult plugins. Test: S3 asserts that a resolver created without `providers` can't walk through a plugin-typed doc that a tab resolver can.
5. **Built-in precedence.** A plugin whose `supportedDatatypes` includes `"folder"`, or whose `matches` returns true for a folder doc, never walks one. Test: S2.

---

## Tasks

### system

### Task S1: filesystem — `sub` children, editing methods, extra providers in walks

**Files:** modify `core/filesystem/src/providers.ts`, `core/filesystem/src/walk.ts`; test `core/filesystem/test/walk.test.ts` (or the existing walk test file; same fixtures).

**Interfaces — produces:**
```ts
// providers.ts
export type Segment = string | number;
export type Child =
  | { name: string; link: AutomergeUrl }
  | { name: string; value: unknown }
  | { name: string; union: AutomergeUrl[] }
  | { name: string; sub: Segment[] };
export interface PathProvider {
  readonly kind: string;
  matches(doc: unknown): boolean;
  lookup(node: unknown, names: string[]): Lookup | undefined;
  list(node: unknown): Child[];
  add?(handle: DocHandle<unknown>, node: unknown, child: { name: string; link: AutomergeUrl }, index?: number): void | Promise<void>;
  rename?(handle: DocHandle<unknown>, node: unknown, name: string, to: string): void | Promise<void>;
  remove?(handle: DocHandle<unknown>, node: unknown, name: string): void | Promise<void>;
}
/** Extra providers, asked after the built-ins (a tab passes the plugin ones). */
export type ExtraProviders = (doc: unknown) => Promise<PathProvider | undefined>;
export function valueAt(node: unknown, segments: Segment[]): unknown;
// walk.ts
WalkOptions.providers?: ExtraProviders;
WalkEnd.sub?: Segment[];   // set when the walk ends at a sub-document
```

- [ ] **Step 1: Write failing tests** with a fake provider `{ kind: "board", matches: d => getType(d) === "board", list: d => [...d.links as {name, link}, { name: "notes", sub: ["notes"] }], lookup: (d, [n]) => … }` over a doc of `@patchwork.type: "board"`:
  - `walkPath(repo, "<acct>/b/child", { accounts, providers })` reaches the linked doc; without `providers` it returns undefined.
  - `walkPath(..., "<acct>/b/notes")` ends with `atDocument: false` and `sub: ["notes"]`, and its pinned path ends `<boardStep>/notes`.
  - `resolveLivePath` of that path returns a handle whose `url` is `stringifyAutomergeUrl({ documentId: board, segments: ["notes"] })`.
  - Deleting `notes` from the doc makes the same walk return undefined.
  - A provider whose `list`/`lookup` throws: the walk returns undefined, and it doesn't throw.
  - `listFiles` on a board container lists `notes` (read from `valueAt`) next to its linked files. `listChildren` returns the board's children when `providers` is passed.
- [ ] **Step 2: Run them** with `pnpm vitest run core/filesystem`. Expected: the new tests fail (no `providers` option; `sub` unknown).
- [ ] **Step 3: Implement.**
  - In `walk.ts`, `const providerOf = async (doc) => providerFor(doc) ?? (await safe(options.providers?.(doc)))`. Use it everywhere `providerFor` is called today (`enter`, `listFiles` root and `read`). `listUnion` and `listChildren` take an optional `providers` argument.
  - A `sub` child is walked like `value`, with `node = valueAt(node, sub)`. Undefined means the walk returns undefined. It extends `at.sub`; a `value` step clears it.
  - A provider's `lookup`/`list` that throws is caught: the walk ends undefined, and the listing gives `[]`.
  - `resolveLivePath`: when `!atDocument && end.sub`, return the handle (canonical view, or live) `.sub(...end.sub)`.
- [ ] **Step 4: Run the tests.** Expected: the whole filesystem suite passes (exit 0).
- [ ] **Step 5: Commit** with message `filesystem: sub-document children, provider editing methods, extra providers in walks`.

### Task S2: plugins — the `patchwork:path-provider` plugin type

**Files:** create `core/plugins/src/path-providers.ts`; modify `core/plugins/src/registry/types.ts` (add it to `RegistryTypeMap`) and `core/plugins/src/index.ts` (export it); test `core/plugins/test/path-providers.test.ts`.

**Interfaces — produces:**
```ts
export type PathProviderDescription = PluginDescription & {
  type: "patchwork:path-provider";
  supportedDatatypes: string[];
};
export type PathProviderPlugin = LoadablePlugin<PathProviderDescription, PathProvider>;
/** Built-ins first, then the first plugin, in registration order, that supports the doc's type, loads, has the right shape, and `matches` the doc. */
export function pathProviderFor(doc: unknown): Promise<PathProvider | undefined>;
/** Only the plugin step: what walks get as `providers`. */
export const packagePathProviders: ExtraProviders;
/** Every type some path-provider plugin supports (never "*"). */
export function pathProviderTypes(): Set<string>;
```

- [ ] **Step 1: Write failing tests:**
  - For a registered `board` provider, `pathProviderFor(boardDoc)` returns it.
  - For a folder doc, `pathProviderFor` returns `folderProvider`, even when a plugin lists `"folder"` and its `matches` returns true.
  - Two plugins for one type: the first registered wins. If the first fails to load, or its module lacks `list`, the second is used, and a warning is logged.
  - `"*"` in `supportedDatatypes` isn't honored, and is warned about.
  - `pathProviderTypes()` gives `{"board"}`.
- [ ] **Step 2: Run** `pnpm vitest run core/plugins`. Expected: FAIL (the module doesn't exist).
- [ ] **Step 3: Implement** on `getRegistry<PathProviderDescription>("patchwork:path-provider")`, with `.filter` and `.load(id)`.
- [ ] **Step 4: Run the tests.** Expected: the plugins suite passes (exit 0).
- [ ] **Step 5: Commit** with message `plugins: patchwork:path-provider plugins`.

### Task S3: tabs walk through plugin providers; the worker doesn't

**Files:** modify `core/bootloader/src/resolver.ts` (an option `providers?: ExtraProviders` on `createResolver`, threaded into `resolveWalkPath`'s walk options), `core/bootloader/src/tab-resolver.ts` (passes `packagePathProviders`), `core/patchwork/src/router.ts` (`resolveLivePath(repo, path, { accounts, providers: packagePathProviders })`); tests in `core/bootloader/test/resolver.test.ts` and `core/patchwork/test/router.test.ts`.

**Consumes:** S1 `WalkOptions.providers`; S2 `packagePathProviders`.

- [ ] **Step 1: Write failing tests:**
  - A resolver created with `providers` answers a `/@/` live path through a board doc with a 307. One created without it (the worker's) answers 404.
  - The router opens `&path=<acct>/b/child` at the linked doc, and `&path=<acct>/b/notes` at `automerge:<board>/notes`, with a board path-provider plugin registered.
- [ ] **Step 2: Run** `pnpm vitest run core/bootloader core/patchwork`. Expected: FAIL.
- [ ] **Step 3: Implement** the threading. Confirm that `automerge-protocol-handler.ts` (the worker) doesn't pass `providers`.
- [ ] **Step 4: Run the tests.** Expected: the bootloader and patchwork suites pass (exit 0).
- [ ] **Step 5: Changeset, spec, commit.**
  - Changeset `.changeset/path-provider-plugins.md` for filesystem, plugins, bootloader and patchwork, saying what was added: `Child`'s `sub`, the editing methods, `WalkOptions.providers`, and `pathProviderFor`/`packagePathProviders`/`pathProviderTypes`.
  - Spec section 6: "Approved … Not implemented" becomes "Implemented"; drop the non-goal's "until section 6 is built" clause.
  - Build `core/filesystem`, `core/plugins`, `core/bootloader` and `core/patchwork` (tsc only, no shell build). Commit.

### base (`paths` branch)

### Task B1: the sidebar finds providers through the host

**Files:** modify `sideboard/src/sideboard/container.ts`; test `sideboard/src/sideboard/container.test.ts`.

**Interfaces — produces:**
```ts
/** Host's plugins.pathProviderFor, else filesystem.providerFor, else nothing. */
export function providerOf(doc: unknown, host?: HostPaths): Promise<PathProvider | undefined>;
/** Reactive: true for directory/branches, or a type a path-provider plugin supports. */
export function useExpandable(host?: HostPaths): (type: string) => boolean;
/** Link and sub children; values without `sub` stay hidden. */
export function containerChildren(doc: unknown, provider: PathProvider | undefined): Array<{ name: string; link: AutomergeUrl } | { name: string; sub: (string | number)[] }>;
```
`HostPaths` is the feature-detected subset of the host's `patchwork-plugins` and `patchwork-filesystem` modules. Tests inject it, as `live-path.ts` does.

- [ ] **Step 1: Write failing tests:**
  - `providerOf` prefers `pathProviderFor`, falls back to `providerFor`, and gives undefined when neither exists.
  - `useExpandable` turns `"board"` true after a fake registry fires `"changed"`.
  - `containerChildren` returns `sub` children and drops bare values.
- [ ] **Step 2: Run** `pnpm vitest run src/sideboard/container.test.ts` in `sideboard/`. Expected: FAIL.
- [ ] **Step 3: Implement.** `canExpand` stays exported (now a non-reactive check) for the existing callers.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B2: provider children, sub-documents and editing in `ContainerItem`

**Files:** modify `sideboard/src/sideboard/document-list/container-item.tsx`, `item.tsx` (an optional `onProviderDrop(items: DndPayloadItem[])`: when set on a read-only row, it accepts document drags as copy and calls it), `item-menu.tsx`/`state.ts` (`MenuTarget` gets `canRename?`/`canRemove?`, which default to `!readOnly`), `document-list.tsx` (uses `useExpandable`); test `sideboard/src/sideboard/document-list/container-item.test.tsx`.

**Consumes:** B1.

- [ ] **Step 1: Write failing tests** with a fake board provider:
  - Expanding a board row lists its link child and its `notes` sub child.
  - Opening `notes` dispatches `{ url: "automerge:<board>/notes", path: "<acct>/…/b/notes" }`.
  - With `rename` and `remove` offered, the child's menu target has `canRename`/`canRemove`, and invoking them calls `provider.rename(handle, doc, "child", "new")` and `provider.remove(handle, doc, "child")`.
  - With none offered, the child is read-only, as now.
  - Dropping a document payload on the board row calls `provider.add(handle, doc, { name, link })` when `add` is offered, and does nothing when it isn't.
  - A provider whose `list` throws renders no children.
- [ ] **Step 2: Run** `pnpm vitest run src/sideboard/document-list/container-item.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `ContainerChildren` resolves `providerOf(doc())` (a resource keyed on the doc) and renders `ChildRow` for links and `SubRow` for subs.
  - A `SubRow` opens `stringifyAutomergeUrl({ documentId, segments })`. Its type is the value's `@patchwork.type`, or empty.
  - Rename and remove go to the provider, with the container's handle and current doc.
- [ ] **Step 4: Run all sideboard tests, then tsc and lint.** Expected: everything passes. tsc shows only the 2–3 errors that were already there (`create-new.tsx`, `document-list-panel.tsx`).
- [ ] **Step 5: Commit, and push `paths`** (PR #94 is open on it).
