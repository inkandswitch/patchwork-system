# Paths phase 4: packages via `/packages` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package management is whatever is bound at `/packages`. The ModuleWatcher loads every package in that union, looks each one up as a pinned `/@/` URL whose list covers the whole package, and imports it from there, checked against the list. New accounts get `/` and `/packages` bound. Old accounts are migrated once.

**Architecture:**
- **Filesystem:** lists of packages go deep, and the walk exposes the union member a package was found in.
- **Bootloader resolver:**
  - a redirect to a container carries its whole list;
  - reads at `heads` ignore whether the path is canonical.
- **ModuleWatcher:** a `folder` source lists `/packages` and watches it. A composite tracker sends `/packages` packages through `/@/` lookups, and everything else through the legacy tracker.
- **Patchwork:** binds `/packages` on new accounts, migrates old ones, and wires the source.

**Tech Stack:** TypeScript, automerge-repo, vitest (node, plus the bootloader's service worker harness). e2e runs in CI only.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, section 4, revised in 274dc28d, and section 5 for lists.

## Global Constraints

- The module list is the `/packages` union listing, deduplicated by document id. Two packages with the same name both load.
- Packages are tracked by document id; a rename reloads nothing.
- When a package's own heads move, the watcher looks it up again and imports the new pinned URL. Other packages keep their URLs.
- A link under `/packages` that isn't a package (no `package.json`) is warned about and skipped.
- Lookup: `/@/<acctHash>/packages/<memberIdhash>@<memberHeads>/<encoded name>` → 307 → the pinned URL. The watcher imports with `importPackageFromHttpUrl(pinnedUrl)`.
- A container with a `package.json` file lists every file under it, through nested folders. Others list only their own files.
- A redirect to a container carries the container's whole list; a redirect to a file, the one-file list.
- The module-settings doc stays a source; its automerge entries are deduplicated against `/packages` by document id.
- `createDefaultAccount` binds `/` to the root folder and `/packages` to a new folder.
- Migration happens once at boot, when the account has `moduleSettingsUrl` and no `/packages` binding:
  - create a folder;
  - link each automerge entry, named by its `package.json` `name`, falling back to the doc title, then to its documentId;
  - bind the folder at `/packages`, leaving `/` to fall back to `rootFolderUrl` as before;
  - leave the module-settings doc untouched.
- `AccountDoc.moduleSettingsUrl` is `@deprecated`.

## Decisions this plan makes

1. **Package lists recurse into nested folders,** but only for a container that has a `package.json`, so fetching a user folder never lists the whole tree. Tails cross folders by name (`sub/x.js`). Each nested file records its own `heads`, so a resolver walks to it by name and reads it at those heads.
2. **Nested folders aren't pinned by heads in a package's list.** A rebuild walks them at their current heads. If a nested folder was restructured, a rebuild of an old list won't match, and that old URL fails as a network error. The live lookup gives a new URL, so imports recover.
3. **Lookups always use the member step.** The tab lists the union, so it knows each member's idhash and heads. The member step finds shadowed packages too, and works the same for unique names.
4. **Composite tracker.** The ModuleWatcher keeps one tracker:
   - `findLatest(url)` answers with the `/@/` lookup for a document id the `/packages` index knows, and with the legacy service worker redirect otherwise;
   - `watch` is shared.
   
   Its `version` strings can be `/@/` URLs. `importPackageSafe` already sends anything that isn't an automerge URL to `importPackageFromHttpUrl`.
5. **Discovery off the main thread is skipped** for `/@/` packages: the module-loader worker path takes automerge URLs only. Moving it over is a follow-up.
6. **The `/packages` index runs in the tab.** It loads the account doc (already loaded) and each member folder doc (small), never the package docs. Each package's `package.json` presence is checked through the lookup instead: a lookup whose list has no `package.json` entry is warned about and skipped.

## Review Focus

- **A package that appears both in module settings and `/packages`** is imported once, through `/packages`. Pinned in Task 4.
- **A rename inside `/packages`** reloads nothing. Removing the link unloads the package. Pinned in Task 4.
- **The same name in two union members:** both load. Pinned in Task 4.
- **A folder package with `./sub/x.js`** imports through its pinned URL. Pinned in Tasks 1 and 2 (filesystem and harness).
- **Migration runs once.** A second boot changes nothing, and an account with `/packages` already bound isn't migrated. Pinned in Task 5.

---

### Task 1: Deep lists for packages; the redirect to a container carries its list

**Files:**
- `core/filesystem/src/walk.ts` (`listFiles` gains `deep`) and `src/file-list.ts`.
- `core/bootloader/src/resolver.ts`.
- Tests: `core/filesystem/test/file-list.test.ts` and `core/bootloader/test/resolver.test.ts`.

**Interfaces:**
- `listFiles(repo, path, options & { deep?: boolean })`. With `deep`, a link child whose document has a provider is listed into, with its name as a tail prefix, instead of being skipped. Branches and account docs are still skipped. Each recursion guards against cycles by documentId.
- `buildFileList` sets `deep` when the container's own listing has a `package.json` entry. That check runs on the shallow pass, then the list is redone deep.
- `pinnedPath(…, { only: "end" })`:
  - when the path ends at a container (`end.tail === ""` and `end.atDocument`), it builds the container's full list;
  - otherwise it builds the one-file list.
- In the resolver's `resolveWalkPath`, a request with `heads` reads with `readPath(…, { heads })` whether or not the path is canonical. Only a request without heads and without `list` redirects when the path isn't canonical.

- [ ] **Step 1: Failing tests**

```ts
// file-list.test.ts
it("lists a package's nested folders deep", ...)
  // a folder package {package.json, sub → folder {x.js}} → tails include "package.json", "sub/x.js"
it("lists a user folder shallow", ...)            // Projects/foo has sub folder, no package.json → no "sub/…"
it("reads a nested file at its recorded heads", ...)  // readPath(`${prefix}/sub/x.js`, {heads}) after x changed → old
// resolver.test.ts
it("redirects a live path to a container with its whole list", ...)  // body list keys include every file
it("reads at heads through a folder reached by name", ...)          // path pkg@h/sub/x.js with heads → 200 old bytes
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS:** both suites.
- [ ] **Step 5: Commit** `paths: package lists go deep; a redirect to a folder carries its list`

### Task 2: The service worker serves a folder package through the harness

**Files:** `core/bootloader/test/service-worker.test.ts` only, unless the test exposes a bug.

- [ ] **Step 1: Test.** An account binds `/packages` to a folder holding a folder package: `package.json` → `{"main":"index.js"}`, `index.js` → `export * from "./sub/x.js"`, and `sub/x.js`. Then:
  - fetch the live `/@/<a>/packages/pkg` → 307;
  - fetch `<location>/package.json` and `<location>/sub/x.js` → both 200, `immutable`;
  - store holds the list and both files.
- [ ] **Step 2: Run.** It should pass if Task 1 is right; a failure here is a bug to fix with systematic debugging.
- [ ] **Step 3: Commit** `service worker: test a folder package end to end`

### Task 3: The `/packages` index and a composite tracker

**Files:** create `core/filesystem/src/packages-folder.ts`; modify `src/index.ts`; test `core/filesystem/test/packages-folder.test.ts`.

**Interfaces:**
```ts
export type PackageEntry = {
  url: AutomergeUrl;            // the package doc, without heads
  name: string;
  memberStep: string;           // docStep(memberIdhash, memberHeads)
};
/** Watch an account's /packages union: call onChange with its entries (deduplicated by documentId, first binding wins) now and whenever the account doc or a member folder changes. */
export function watchPackagesFolder(repo: Repo, account: DocHandle<AccountNamespaceDoc>,
  onChange: (entries: PackageEntry[]) => void): () => void;
/** The live lookup path for an entry. */
export function packageLookupPath(acctHash: string, entry: PackageEntry): string;
  // `${acctHash}/packages/${entry.memberStep}/${encodeURIComponent(entry.name)}`
/** A tracker that answers findLatest through /@/ for the urls `entries()` knows, and through `fallback` otherwise. */
export function trackPackagesFolder(acctHash: Promise<string>, entries: () => PackageEntry[],
  fallback: PackageTracker, lookUp?: (path: string) => Promise<string>): PackageTracker;
  // lookUp default: fetch(`/@/${path}`) → response.url (redirected) → the pinned URL; throws if not redirected
```

- [ ] **Step 1: Failing tests:** entries from a two-member union, deduplicated, with the same name in both; onChange after a member folder gains an entry; `packageLookupPath`; the tracker routes a known url to `lookUp` and an unknown one to `fallback`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `filesystem: watch /packages and look packages up through it`

### Task 4: The ModuleWatcher loads `/packages`

**Files:** `core/filesystem/src/module-watcher.ts`; test `core/filesystem/test/module-watcher.test.ts`.

**Interfaces:**
- `ModuleWatcher.addPackagesFolder(name: string, entries: () => PackageEntry[], subscribe: (onChange: () => void) => () => void): Promise<void>`.
- The module list is the settings docs' modules plus the folder's entry urls, deduplicated by `stripHeads` (document id). An entry present in `/packages` is keyed by its bare url. The tracker (composite, constructed by the caller) decides how it's looked up.

- [ ] **Step 1: Failing tests** (existing fakes in module-watcher.test.ts):

```ts
it("loads every package in the folder", ...)
it("loads a package in both settings and /packages once", ...)
it("doesn't reload a renamed package", ...)
it("unloads a package removed from the folder", ...)
it("loads both packages with one name in two members", ...)
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run the filesystem suite, expect PASS.**
- [ ] **Step 5: Commit** `filesystem: ModuleWatcher loads the /packages folder`

### Task 5: Accounts bind `/packages`; migration; wiring

**Files:**
- `core/patchwork/src/createAccount.ts`.
- Create `core/patchwork/src/migrate-packages.ts`.
- `core/patchwork/src/index.ts` (wire the folder source and the composite tracker).
- `core/plugins/src/account.ts` (`@deprecated` on `moduleSettingsUrl`).
- Test `core/patchwork/test/migrate-packages.test.ts`.

**Interfaces:**
- `migratePackages(repo, account): Promise<boolean>`:
  - true if it migrated;
  - a no-op when `/packages` is bound or there's no `moduleSettingsUrl`;
  - names come from `package.json` `name` (read with `resolvePath(repo, pkg, ["package.json"])`), then the doc's `title`, then its documentId.
- `createDefaultAccount`: `doc.namespace = { "/": [{ url: rootFolder.url }], "/packages": [{ url: packagesFolder.url }] }`. The packages folder is titled "Packages". `moduleSettingsUrl` is still created, for the Packages UI.

- [ ] **Step 1: Failing tests:**
  - migration links each automerge entry by its `package.json` name and binds `/packages`;
  - a second run is a no-op;
  - an http entry is left to module settings;
  - an account already bound isn't touched;
  - `createDefaultAccount` binds both mounts.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement**, then wire in `index.ts`:
  - after `registerAccount`, `await migratePackages`;
  - `watchPackagesFolder` feeds `moduleWatcher.addPackagesFolder("packages", …)`;
  - the tracker passed to the ModuleWatcher is `trackPackagesFolder(acctHash, () => latestEntries, trackPackagesViaServiceWorker(…))`;
  - `acctHash` comes from `registerAccount`'s return. The watcher is built before the account resolves, so the tracker takes promises/getters.
- [ ] **Step 4: Run the patchwork suite and typecheck, expect PASS.**
- [ ] **Step 5: Commit** `patchwork: /packages on new accounts, migration, and wiring`

### Task 6: Changeset

- [ ] **One changeset** for the filesystem, bootloader, plugins and patchwork packages, saying:
  - `/packages` is package management;
  - packages are imported through checked `/@/` URLs;
  - module settings is deprecated but still read;
  - what moved: `moduleSettingsUrl` is `@deprecated`.
- [ ] Commit.
