# Package database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One package database in `core/filesystem`, in memory and saved to IndexedDB. The view, router and themes read from it, and `patchwork-plugins` becomes a deprecated wrapper over it in `packages/plugins`.

**Architecture:** The database holds the newest version of each package (its `package.json`, base url, plugins, and who added it) and saves every version. Writes are synchronous in memory and saved in the background. Everything that loads packages writes to it, and each part of core reads the plugin shape it needs straight from it.

**Tech Stack:** TypeScript, automerge-repo, vitest (happy-dom for the DOM), `fake-indexeddb` in tests, pnpm + changesets.

**Spec:** `docs/superpowers/specs/2026-11-24-package-database-design.md`

## Global Constraints

- Branch `package-database`, worktree `../worktrees/system/package-database`. Branch from `main` once #517 (`package-url`) has merged, else from `package-url`.
- One branch, one release, **one** changeset listing every package touched (Task 13). `@inkandswitch/patchwork` is `minor`, because it loses `Patchwork.plugins`. Everything else is `patch`.
- Tests run on astrobleme.local. Sync the worktree to `~/tmp/pw-package-database`, `pnpm install` there, and run each vitest command below over `ssh astrobleme.local 'cd ~/tmp/pw-package-database && …'`. `pnpm -r exec tsc --noEmit` can run locally.
- Stage files by name, never a directory.
- The database knows nothing about tools, themes or datatypes. The one exception: on `add` it applies the legacy renames `registerPlugins` does today (`supportedDataTypes` → `supportedDatatypes`, `patchwork:dataType` → `patchwork:datatype`).
- Not supported, so warn and skip: functions in a plugin description other than `load`, `import` and `module`, and module urls with no `package.json`.
- **STOP** after Tasks 5, 11 and 13. chee runs each step locally before the next.
- Ignore `../lattice`, `../seahive` and `../three`.

## Review Focus

1. **Core's own `registerPlugins` right after the watcher's add, for the same import.** Expected: still one entry, added by the package list, and still saved. Tested in Task 5.
2. **Two packages with the same tool id.** Expected: lookup by id gives the one added last, and `plugins(type)` gives both. Tested in Tasks 1 and 7.
3. **Booting from last visit after a package left the list.** Expected: it's removed once the lists are read. Tested in Task 11.
4. **Two accounts on one origin.** Expected: each sees only its own saved entries. Tested in Task 2.

---

## Step 1: everything writes to the database. Nothing reads from it yet.

### Task 1: The in-memory database

**Files:** create `core/filesystem/src/package-db/{types,database,index}.ts`. Move `core/plugins/src/registry/source.ts` to `core/filesystem/src/package-db/source.ts`, and leave a re-export behind. Export it all from `core/filesystem/src/index.ts`, and add `eventemitter3` to filesystem's dependencies. Test: `core/filesystem/test/package-db.test.ts`.

**Interfaces:**
```ts
export type AddedBy =
  | { by: "package-list"; entry: string }   // the ModuleWatcher's moduleKey
  | { by: "package-url" }
  | { by: "suggested" }
  | { by: "js"; url: string; stack: string };

export type PluginRecord = { type: string; id: string; export?: string } & Record<string, unknown>;
export type LivePlugin = PluginRecord & { load?: () => Promise<unknown>; import?: string; module?: unknown };

export type PackageEntry = {
  key: string;          // sourceOf(importUrl)
  version: string;      // heads ("a|b"), or sha-256 hex of the package.json body
  importUrl: string;    // heads-pinned automerge url, or the http url
  base?: string;        // package root, ending in "/"
  packageJson?: Record<string, unknown>;
  plugins: LivePlugin[];
  addedBy: AddedBy[];
  addedAt: number;
};
export type PluginView = PluginRecord & { importUrl: string; package: PackageEntry; module?: unknown };

export class PackageDatabase {
  constructor(options?: { importModule?: (url: string) => Promise<any> });
  add(entry: Omit<PackageEntry, "addedBy" | "addedAt"> & { addedBy: AddedBy }): PackageEntry;
  remove(key: string): boolean;
  get(key: string): PackageEntry | undefined;
  all(): PackageEntry[];
  plugins(type: string): PluginView[];
  plugin(type: string, id: string): PluginView | undefined;
  load(view: PluginView): Promise<unknown>;
  isLoading(view: PluginView): boolean;
  on(event: "added" | "removed", cb: (entry: PackageEntry) => void): () => void;
  on(event: "replaced", cb: (entry: PackageEntry, previous: PackageEntry) => void): () => void;
  on(event: "loaded", cb: (view: PluginView) => void): () => void;
}
export const packages: PackageDatabase;
```

The rules:
- **`add` is synchronous** and fires its event before it returns.
  - Same key, same version, and no live plugins (`load`, `import` or `module`) in the new one: merge `addedBy`, and fire nothing.
  - Otherwise the new entry becomes the newest: `added` if there was none, else `replaced`.
- **`plugin(type, id)`** comes from the most recently added entry that has it. **`plugins(type)`** returns every match across the newest entries, oldest first.
- **`load(view)`** keeps one promise per `importUrl`, `type` and `id`, and forgets a failed one. It tries, in order:
  1. `view.module`, if it's set.
  2. The live `load` or `import`.
  3. A manifest `export`, resolved with `resolvePackageExport` against `base`: its default export, or the whole module. With no `export`, `undefined`.
  4. Otherwise, `importPluginFromPackage(importUrl, type, id)`. That function takes `importModule` as a new last parameter.

  On success it fires `loaded`, with `module` set.

- [ ] **Step 1: Write failing tests:**
  - `add fires added, then replaced for a new version, synchronously`
  - `same version merges addedBy and fires nothing`
  - `a live add at the same version replaces`
  - `remove fires removed`
  - `ids that collide: plugin() is the one added last, plugins() has both`
  - `legacy names are renamed`
  - `load imports a manifest export against base, once`, with `exports {"./t":"./t.js"}`, `base "https://x.test/p/"`, and `importModule` called once with `"https://x.test/p/t.js"`
  - `load of an index.js plugin picks type and id from the entry point`
  - `a failed load is tried again`
  - `loaded fires with module set`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/package-db.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Also run `pnpm --filter @inkandswitch/patchwork-plugins exec vitest run`, which should still PASS.
- [ ] **Step 5: Commit** the files above by name: `"add an in-memory package database to filesystem"`.

### Task 2: Saving, and news for other tabs

**Files:** create `core/filesystem/src/package-db/saved.ts`, modify `database.ts`, and add `fake-indexeddb` as a devDependency. Test: `core/filesystem/test/package-db-saved.test.ts`.

**Interfaces** (on `PackageDatabase`):
```ts
open(name: string): Promise<void>;           // hydrate, then save from now on; memory-only without indexedDB
ready: Promise<void>;                        // resolved once hydrated, or at once if never opened
versions(key: string): Promise<PackageEntry[]>;  // every saved version, oldest first
announce(key: string): void;                 // tell other tabs
onNews(cb: (key: string) => void): () => void;
```
- **Database name:** `patchwork-packages ${accountUrl}`. The caller builds it (Task 5).
- **IndexedDB v1:**
  - Store `versions`, with keyPath `["key","version"]` and an index on `key`.
  - Store `current`, with keyPath `key`, holding `{ key, version }`.
- **What gets saved:**
  - Live entries are never saved.
  - `remove` deletes from `current` and keeps `versions`.
  - Plugins are saved without `load`, `import` or `module`.
  - Hydrating fires `added` for each entry.
  - Writes go in order, and a failed write is `console.warn`ed.
- **BroadcastChannel:** named `patchwork:packages`, with message `{ key }`. The database never acts on it itself.

- [ ] **Step 1: Write failing tests** (`import "fake-indexeddb/auto"`):
  - `an opened database comes back on the next open`
  - `accounts stay apart`
  - `live entries aren't saved`
  - `removed packages aren't current but keep their versions`: `versions()` gives `["v1","v2"]`
  - `entries added before open are saved by open`
  - `announce reaches onNews in another database`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/package-db-saved.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Commit**: `"save the package database to indexeddb, by account"`.

### Task 3: Imports hand back the package.json they read

**Files:** modify `core/filesystem/src/packages.ts` and `core/bootloader/src/module-loader.ts`. Tests: `core/filesystem/test/plugin-manifest.test.ts`, and `core/bootloader/test/module-loader.test.ts` (create it if it's missing).

**Interfaces:**
```ts
export type PackageJsonAt = { importUrl: string; base: string; packageJson: Record<string, any>; version: string };
export type ImportedPackage = { plugins: any[]; package?: PackageJsonAt };
export function readPackageJson(url: string): Promise<PackageJsonAt | undefined>; // undefined for a module url
export function importPackageWithJson(url: string): Promise<ImportedPackage>;
```
- **`version`:**
  - Automerge: the part of the url after `#`.
  - Http: the hex SHA-256 of the `package.json` body. `locateHttpPackage` reads `text()`, then parses it.
- **One fetch.** `importPackageWithJson` fetches `package.json` once, and `readPluginManifest` is built on `readPackageJson`.
- **The bootloader:** `importAutomergePackageViaWorker` returns `ImportedPackage`, with `package` taken from the read it already does.

- [ ] **Step 1: Write failing tests:**
  - `http version is the sha-256 of the body`
  - `automerge version is the url's heads`
  - `a module url has no package.json`
  - `importPackageWithJson fetches package.json once`
  - bootloader: `the worker path returns the package.json it read`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/plugin-manifest.test.ts` and `pnpm --filter @inkandswitch/patchwork-bootloader exec vitest run test/module-loader.test.ts`
- [ ] **Step 3: Implement.** `importPackage` doesn't change.
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Commit**: `"hand back the package.json an import read, with its version"`.

### Task 4: The ModuleWatcher writes what it loads

**Files:** modify `core/filesystem/src/module-watcher.ts`. Test: `core/filesystem/test/module-watcher.test.ts`.

**Interfaces:**
- **New members:** a `database?: PackageDatabase` property, set by the caller, and `recheck(key: string): void`. `recheck` re-runs `processModuleEntry` for each watched automerge entry whose `sourceOf` is `key`.
- **Importer type:** `importAutomergePackage` returns `Promise<ImportedPackage>`. The default, and the http path, use `importPackageWithJson`.
- **The add, just before `onLoad`:**
  - Call `database.add({ key: sourceOf(importUrl), version, importUrl, base, packageJson, plugins, addedBy: { by: "package-list", entry: moduleKey } })`.
  - `plugins` is the manifest's records, each with its `export`. With no manifest, it's `mod.plugins` without `load`, `import` or `module`.
  - Call `database.announce(key)` when it's a new version.
  - With no `package`, warn once and add nothing.
- **Unloads:** they also call `database.remove(sourceOf(importUrl))`.

- [ ] **Step 1: Write failing tests:**
  - `a loaded package is in the database before onLoad runs`
  - `a new version replaces the entry and is announced`
  - `a package leaving the settings is removed`
  - `a module url isn't added`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/module-watcher.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Run it together with `test/module-watcher-service-worker.test.ts`.
- [ ] **Step 5: Commit**: `"the module watcher adds what it loads to the package database"`.

### Task 5: The other writers, and setup

**Files:** modify `core/plugins/src/registry/index.ts`, `core/elements/src/legacy-impl.ts` and `core/patchwork/src/index.ts`. Tests: `core/plugins/test/registry.test.ts` and `core/elements/test/patchwork-view.test.ts`.

- **`registerPlugins(plugins, importUrl)`** still fills the old registry. It also calls `packages.add({ key: sourceOf(importUrl), version: importUrl, importUrl, plugins, addedBy: { by: "js", url: importUrl, stack: new Error().stack ?? "" } })`, unless `packages.get(key)` was added by a package list or a suggestion at that same `importUrl`.
- **A suggested package someone confirmed:** if `readPackageJson(url)` finds one, add it by `{ by: "suggested" }` before `registerPlugins`.
- **`package-url`:** after `loadPackageTool` imports, add the package by `{ by: "package-url" }` if `packages.get` has nothing for it.
- **`setup()`:**
  - Set `moduleWatcher.database = packages`, and wire `packages.onNews((key) => moduleWatcher.recheck(key))`.
  - Call `packages.open(\`patchwork-packages ${url}\`)`, without awaiting it. The url comes from `localStorage.getItem(accountKey)` when that's a valid automerge url. Otherwise, call it after `resolveAccountHandle` with `accountDocHandle.url`.

- [ ] **Step 1: Write failing tests:**
  - `registerPlugins adds a js entry with a stack`
  - `registerPlugins after the watcher's add at the same url leaves the entry alone`: still by `package-list`, still not live
  - `registerPlugins twice from js at one url: the second wins`
  - elements: `package-url adds the package when there's no entry`, and `leaves an existing one alone`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-plugins exec vitest run test/registry.test.ts` and `pnpm --filter @inkandswitch/patchwork-elements exec vitest run test/patchwork-view.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Also run `pnpm --filter @inkandswitch/patchwork exec vitest run`. `tsc` should be clean.
- [ ] **Step 5: Commit**: `"every writer adds to the package database"`.

**CHECKPOINT 1: STOP.** chee runs it locally. IndexedDB should have every listed package, added by `package-list`, and nothing on screen should have changed.

---

## Step 2: `<patchwork-view>`, the router, themes and `package-info.ts` read from it

### Task 6: Account, `isKeyhiveDoc` and `createDocOfDatatype2` move to filesystem

**Files:**
- Move `core/plugins/src/account.ts` and `core/plugins/src/keyhive.ts` into `core/filesystem/src/`.
- Put `createDocOfDatatype2` (with `splitImportUrl`) in `core/filesystem/src/create-doc.ts`.
- Plugins re-exports all of them.
- Point core's imports of them at filesystem: `elements/src/keyhive-access.ts`, `elements/src/patchwork-view.ts`, `patchwork/src/{index,createAccount,types,router}.ts`.
- Move any tests for them with them.

**Interfaces:**
```ts
export function createDocOfDatatype2<D>(
  datatype: { id: string; importUrl?: string; module: { init(doc: D, repo: Repo): void } },
  repo: Repo,
  change?: (doc: D) => void,
  hive?: { addSyncServerRelayToDoc(url: AutomergeUrl): Promise<unknown> },
): Promise<DocHandle<D & HasPatchworkMetadata>>;
```
The `hive` type is structural, so filesystem doesn't take on a keyhive dependency.

- [ ] **Step 1: Move them.**
- [ ] **Step 2: Check.** `tsc` is clean, and the filesystem and plugins vitest suites PASS.
- [ ] **Step 3: Commit**: `"move account, isKeyhiveDoc and createDocOfDatatype2 to filesystem"`.

### Task 7: `<patchwork-view>` reads tools and components from the database

**Files:**
- Create `core/elements/src/tools.ts`.
- Modify `legacy-impl.ts` and `patchwork-view.ts`.
- Drop `@inkandswitch/patchwork-plugins` from `core/elements/package.json`.
- Tests: `patchwork-view.test.ts` and `keyhive.test.ts`, with their setup switched to `packages.add`.

**Interfaces** (`tools.ts`; elements owns "a tool"):
```ts
export type ToolView = PluginView & { name: string; supportedDatatypes: "*" | string[]; tags?: string[]; unlisted?: boolean; forTitleBar?: boolean; module?: ToolRender };
export function tool(id: string): ToolView | undefined;
export function tools(): ToolView[];
export function toolsForType(type: string): ToolView[];
export function defaultTool(doc: HasPatchworkMetadata): ToolView | undefined; // getFallbackTool's order, only over packages a package list added
export function onToolsChange(cb: (event: "registered" | "loaded", view: ToolView) => void): () => void; // added/replaced → registered
```
- **`tools.ts` has its own `ToolRender` and `ToolElement`.**
- **In `legacy-impl.ts`:**
  - These functions replace every registry call.
  - `packages.load(view)` replaces `toolRegistry.load`.
  - The existing `importUrl` comparison remounts the view in place when a new version arrives.
  - `knownTypes()` reads the datatypes from the database.
  - A suggested package now only adds its entry, with no `registerPlugins`.
- **In `patchwork-view.ts`:** `patchwork:component` is read the same way.
- **When it's done**, nothing in `core/elements` imports `patchwork-plugins`, which Task 8 needs.

- [ ] **Step 1: Write failing tests:**
  - `a view mounts a tool from the database`
  - `a new version of its package remounts in place`
  - `the default tool ignores packages only js added`
  - `same tool id in two packages: the one added last mounts`
  - `a component renders from the database`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-elements exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS**, #517's tests included. `grep -rn patchwork-plugins core/elements/src core/elements/test core/elements/package.json` should print nothing.
- [ ] **Step 5: Commit**: `"patchwork-view reads tools and components from the package database"`.

### Task 8: Themes move to elements and read the database

**Files:**
- Move `core/plugins/src/themes.ts` to `core/elements/src/themes.ts`, and its test with it.
- Export it from elements.
- Plugins re-exports it and depends on elements.
- `core/patchwork` imports `startThemes` and `followThemePreferences` from elements.

**Changes:**
- Every export keeps its name and signature.
- Themes are looked up with `packages.plugin("patchwork:theme", id)`.
- A relative `style` resolves against `view.package.base` when there is one. Otherwise it resolves against `styleBase(view.importUrl)`, as now.
- Stylesheets re-sync on `added`, `replaced` and `removed`.

- [ ] **Step 1: Switch the tests to `packages.add`**, and add `a relative style resolves against the package base`.
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-elements exec vitest run test/themes.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Also run `pnpm --filter @inkandswitch/patchwork exec vitest run test/theme-tokens.test.ts`.
- [ ] **Step 5: Commit**: `"themes live in elements and read the package database"`.

### Task 9: The router, preloading and `create` read from the database

**Files:** modify `core/patchwork/src/{router,load-order,index}.ts`. Tests: `router.test.ts` and `load-order.test.ts`, with their setup switched to `packages.add`.

- **The frame tool:** the first of `packages.plugins("patchwork:tool")` that's tagged `frame-tool` and isn't `unlisted`.
- **Titles:** `packages.plugin("patchwork:datatype", type)` → `load` → `getTitle`. If it isn't there yet, wait for an `added` or `replaced` that brings it.
- **`preloadPlugins`:** listens for `added` and `replaced`, and loads each planned `{type, id}`.
- **`create(type)`:** waits for the datatype as `loadWhenReady` does now, loads it, then calls `createDocOfDatatype2`.

- [ ] **Step 1: Switch the setup, and add a failing test:** `create waits for a datatype added later`.
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork exec vitest run test/router.test.ts test/load-order.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Run the whole `@inkandswitch/patchwork` suite.
- [ ] **Step 5: Commit**: `"router, preload and create read from the package database"`.

### Task 10: `package-info.ts` uses the database's package.json

**Files:** modify `core/elements/src/package-info.ts`. Test: `package-info.test.ts`.

**Changes to `readClaims(url)`:**
- It uses `packages.get(sourceOf(url))`'s `packageJson` when that entry is at `url`, or when `url` isn't pinned. Otherwise it fetches, as now.
- The plugin claims come from `patchwork.plugins` when that's there, and from top-level `plugins` when it isn't.

- [ ] **Step 1: Write failing tests:** `readClaims uses the database without fetching`, and `readClaims lists patchwork.plugins`.
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-elements exec vitest run test/package-info.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Commit**: `"package-info reads package.json from the package database"`.

### Task 11: Booting from last visit

**Files:** modify `core/patchwork/src/index.ts`, `core/patchwork/src/types.ts` and `core/filesystem/src/module-watcher.ts`. Tests: `core/patchwork/test/boot-from-last-visit.test.ts` and `core/filesystem/test/module-watcher.test.ts`.

- **The setting:** `PatchworkOptions.bootFromLastVisit?: boolean`, default `false`. `localStorage["patchwork:boot-from-last-visit"]` (`"on"` or `"off"`) overrides it. Export `bootFromLastVisit(option, storage): boolean`.
- **On:** the router waits for `packages.ready` instead of `firstToolsLoaded`. Newer heads replace entries, and Task 7 remounts the view in place.
- **Off:** nothing changes.
- **Either way:** once both package lists have been read, the watcher removes every entry a package list added whose `entry` isn't in the lists any more. This goes in `core/filesystem/src/module-watcher.ts`, using the list it already passes to `onModules`.

- [ ] **Step 1: Write failing tests:**
  - `the localStorage override beats the option`, all four combinations
  - watcher: `a saved package that left the list is removed once the lists are read`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork exec vitest run test/boot-from-last-visit.test.ts` and `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/module-watcher.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** Run the whole suite. `tsc` should be clean.
- [ ] **Step 5: Commit**: `"boot from last visit's packages, behind a setting"`.

**CHECKPOINT 2: STOP.** chee runs it locally with the setting on and off, and picks the default. Write that default into Task 11 before going on.

---

## Step 3: `patchwork-plugins` over the database, deprecated, moved

### Task 12: `patchwork-plugins` rewritten over the database

**Files:** modify `core/plugins/src/registry/{registry,index}.ts`, `core/plugins/src/{tools,index}.ts` and `core/patchwork/src/{index,types}.ts`. Test: `core/plugins/test/registry.test.ts`. The existing cases must pass unchanged.

`PluginRegistry` keeps every public method and its signature, and holds nothing itself:
- **`get`, `all`, `filter`, `has`:** `packages.plugins(type)`, one per id, the one added last winning.
- **`register(plugin, importUrl)`:** if the package's newest entry was added only by JS, add a new version of it with this plugin added or replaced. Otherwise, add a new JS entry holding just this plugin.
- **`remove(id)`:** add a new version of its entry without it, or remove the entry if it had only that plugin.
- **`load`, `loadAll`, `loadWhenReady`, `isLoading`:** over `packages`. Keep the async `getTitle`/`setTitle` warnings.
- **Events:** `on(...)` is translated synchronously from the database's events, filtered to the registry's type.
  - `added` or `replaced` → `registered` for each plugin in the entry, then `removed` for each id the entry has dropped, then `changed`.
  - `removed` → `removed` for each id, then `changed`.
  - `loaded` → `loaded`, then `changed`.
- **`unregisterPlugins(importUrl)`:** `packages.remove(sourceOf(importUrl))`.
- **Deprecation:** every export gets `@deprecated`, pointing at `packages` in filesystem or the tools in elements.
- **`core/patchwork`:** stops calling `registerPlugins` and `unregisterPlugins`, because the watcher's add and remove are the registration now. It drops `Patchwork.plugins` and `PluginsApi`, and stops importing `patchwork-plugins`.

- [ ] **Step 1: Write failing tests:**
  - `register emits registered then changed before it returns`
  - `a package added to the database shows in getRegistry`
  - `remove takes one plugin out of a js package`
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @inkandswitch/patchwork-plugins exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, expect PASS.** The `@inkandswitch/patchwork` suite should PASS too. `grep -rn 'patchwork-plugins"' core --include=*.ts | grep -v '^core/plugins/' | grep -v externals-list` should print nothing.
- [ ] **Step 5: Commit**: `"patchwork-plugins is a deprecated view of the package database"`.

### Task 13: Move to `packages/plugins`, tidy up, changeset

- **Move:** `git mv core/plugins packages/plugins`, then:
  - Update `repository.directory` in its `package.json`.
  - In `vitest.config.ts`, change `core/plugins` to `packages/plugins`.
  - Drop `@inkandswitch/patchwork-plugins` from `core/patchwork/package.json`.
  - Run `pnpm install`.
- **Keep:** it stays in `core/bootloader/src/externals-list.ts` and in the bootloader's dependencies, so base still gets one shared copy.
- **Delete, after asking chee:** `core/filesystem/src/pinned-package-json.ts` and `.changeset/heads-lookup-keeps-package-json.md`. Both are untracked in the main checkout.
- **Write `.changeset/package-database.md`:**
  - Bumps: `patchwork-filesystem`, `patchwork-elements`, `patchwork-bootloader` and `patchwork-plugins` are `patch`. `@inkandswitch/patchwork` is `minor`.
  - The body says:
    - Filesystem has a package database (`packages`), saved to IndexedDB by account.
    - `<patchwork-view>`, the router and themes read from it.
    - Themes are now exported from elements. Account, `isKeyhiveDoc` and `createDocOfDatatype2` are exported from filesystem.
    - `patchwork-plugins` is deprecated, sits over the database, and lives in `packages/plugins`.
    - `Patchwork.plugins` is gone: import `packages` from filesystem instead.
    - `setup()` takes `bootFromLastVisit`.

- [ ] **Step 1: Move and edit.**
- [ ] **Step 2: Check.** `tsc` is clean locally, and on astrobleme `pnpm vitest run` from the root passes, `packages/plugins` included.
- [ ] **Step 3: Commit.** `git mv` has already staged the move. Add `packages/plugins/package.json`, `vitest.config.ts`, `core/patchwork/package.json`, `pnpm-lock.yaml` and `.changeset/package-database.md` by name. Message: `"move patchwork-plugins to packages/"`.

**CHECKPOINT 3: STOP.** chee runs it locally with base's sideboard and the cards experiment, which still use `registerPlugins`.
