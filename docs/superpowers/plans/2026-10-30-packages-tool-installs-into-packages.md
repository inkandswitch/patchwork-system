# The Packages tool installs into /packages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On a host that loads `/packages`, the Packages tool installs a package by linking it into the account's own packages folder, and uninstalls one by removing that link. Module settings stops growing. Once it holds nothing `/packages` doesn't cover, the Packages button retires itself; the rule for that is already built.

**Architecture:** All in base, in `packages/` (the tool). The tool keeps its handle, the module-settings doc. It finds the account through `globalThis.patchwork.account`, as the sidebar does, and the repo through its element. It writes to the folder bound first at `/packages`. The host's ModuleWatcher already loads, unloads and dedupes whatever that folder lists, so nothing changes in system except the spec.

**Tech stack:** Solid, vitest with happy-dom, base's standalone-package rules (no build-time imports between tools; `@inkandswitch/patchwork-*` are host externals, feature-detected).

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, section 4 ("module settings still read; the Packages UI writes it" becomes "the Packages UI writes `/packages`").

## Decisions

1. **Where an install goes.**
   - An unpinned automerge URL goes into **your** packages folder: the first binding at `/packages`.
   - Pinned URLs (with heads) and http URLs still go into module settings. A folder link floats to the latest version, and a folder can't hold an http module.
   - On a host that doesn't load `/packages`, or an account without it bound, everything goes into module settings, as now.
2. **What a link looks like.** `{ name, type, url }`:
   - `url` is the bare automerge URL.
   - `type` is the package doc's `@patchwork.type`, or `folder`.
   - `name` is its package.json `name`, else its title, else its document id. The same allocator as migration keeps names unique (`alpha`, `alpha (2)`, `alpha (3)`), since only the first of a name in a folder is reachable.
3. **"Installed" means in your packages folder, or listed in module settings.**
   - A package linked from another `/packages` member (a team folder) is shown as installed, from that folder's title, with no Remove: removing the link there would uninstall it for everyone who shares the folder.
   - Module-settings entries recorded in `movedToPackages` count as installed only if the folder still links them, matching what the host loads.
4. **Uninstall:**
   - removes the package's link from your folder (every link to that document, in case of duplicates);
   - removes an unmoved, unpinned module-settings entry for the same document;
   - pinned and http entries are removed from module settings as now;
   - `deactivateModule` still runs, so the plugins go away immediately.
5. **No move button for leftovers.** Bare entries an older host adds to module settings later still load, through module settings, and stay removable there. Moving them over can come later if it's wanted.

## Review focus

1. **Two tabs installing the same package at once.** Both push a link; the second is a duplicate, and only the first of a name is reachable. The install checks for the document inside the `change` callback, so concurrent installs in one tab can't double up. Across devices it's a merge; the host dedupes by document. Test: installing an already-linked document is a no-op.
2. **A package doc that can't be read yet** (unsynced). It's linked under its document id rather than failing the install. Test.
3. **Your folder not loaded yet when the tool opens.** The install waits for it rather than falling back to module settings, which would put it in the wrong place. Test with a slow `find`.
4. **An older host.** No `watchPackagesFolder` on the host's filesystem: every install goes to module settings. Test.
5. **A link from someone else's folder.** It's never removed by Uninstall. Test.

---

## Tasks

### Task 1: `packages/src/packages-folder.ts` — where installs go, and the folder edits

**Files:** create `packages/src/packages-folder.ts` and `packages/src/packages-folder.test.ts`.

**Produces:**
```ts
export type AccountLike = { doc(): { namespace?: Record<string, { url?: unknown }[]> } | undefined };
/** Your packages folder (the first /packages binding), on a host that loads /packages; else undefined. */
export function installFolderUrl(account: AccountLike | undefined, hostLoadsPackages: boolean): AutomergeUrl | undefined;
/** Whether `url` goes into the packages folder: an unpinned automerge url. */
export function installsIntoFolder(url: string): boolean;
/** A name not in `taken`: `name`, `name (2)`, … */
export function uniqueName(name: string, taken: Iterable<string>): string;
/** Link `url` into the folder under a unique name; a no-op if it already links that document. */
export function linkPackage(folder: DocHandle<FolderDoc>, link: { url: AutomergeUrl; name: string; type: string }): void;
/** Remove every link to `documentId` from the folder. True if any went. */
export function unlinkPackage(folder: DocHandle<FolderDoc>, documentId: string): boolean;
```

- [ ] Tests first, covering:
  - `installFolderUrl`: the first binding; undefined without `/packages` or on an older host;
  - `installsIntoFolder`: true for a bare automerge url; false with heads, and false for http;
  - `uniqueName("alpha", ["alpha", "alpha (2)"])` → `"alpha (3)"`;
  - `linkPackage`: adds `{name, type, url}`; a second call for the same document adds nothing;
  - `unlinkPackage`: removes duplicates too, and returns false when there's nothing to remove.
- [ ] Run `npx vitest run src/packages-folder.test.ts` in `packages/`. It should fail first, then pass once implemented.
- [ ] Commit.

### Task 2: the tool installs and uninstalls through it

**Files:** modify `packages/src/packages.tsx` (install, uninstall), `packages/src/use-package-data.ts` (installed keys, and where each package is from), `packages/src/origin.ts` (an origin hint for "in your packages folder" vs "from <folder>"); tests in `packages/src/packages.test.tsx`.

**Consumes:** Task 1.

- [ ] Tests first, with a fake account and fake folder handles on a fake repo:
  - Installing a bare automerge URL links it into your folder, named from package.json, and leaves module settings alone.
  - Installing a pinned or http URL writes module settings.
  - On an older host (the host check returns false), everything goes to module settings.
  - Uninstalling a package in your folder removes its link and calls `deactivateModule`.
  - A package linked only from a second binding shows as installed, with no Remove button.
  - A package whose doc can't be read is linked under its document id.
  - Installing while your folder is still loading waits for it.
- [ ] Implement:
  - `use-package-data` reads the account's `/packages` members (repo `find`, plus their `change` events) and merges their document ids into `installedKeys`, tagging each with its member.
  - `install`/`uninstall` follow the decisions above.
  - The host check is `typeof filesystem.watchPackagesFolder === "function"`.
- [ ] Run every `packages/` test, `tsc -p` and the package's build. They should pass, with no new tsc errors.
- [ ] Commit.

### Task 3: spec and push

- [ ] System spec section 4: the Packages UI installs into `/packages`; module settings keeps pinned and http entries and what older hosts add. Commit to `paths-design`.
- [ ] Push base `paths`.
