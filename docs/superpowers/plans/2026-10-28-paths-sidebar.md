# Paths in the sidebar: packages as a real folder, status, open at a path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In the shell, `/packages` shows up as a real `packages` folder in the sidebar tree. Each package row shows whether it loaded. Opening anything from the sidebar opens it at its live path: `&path=` is set, and the tool gets `<patchwork-view path>`. The account bar's Packages link goes once `/packages` is bound.

**Architecture:** This spans two repos.
- **system** (`paths-design`):
  - the ModuleWatcher reports each package's status;
  - accounts get a root-folder link to their `/packages` folder.
- **base** (`paths`), each tool standalone, with no build-time links between them:
  - `providers`: `selected-view` carries `path`;
  - `threepane`: passes it to the main view, and hides the Packages link;
  - `sideboard`: rows open with their live path and show package status, and the separate Packages section is removed.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, section 3 (*Opening at a path*: "the sidebar dispatches `{ url, path }` on click, using the names it walked") and section 4.

## Decisions

1. **The `packages` folder is real.** It's a link named `packages` in the root folder, to the first folder bound at `/packages`. The mount shadows a same-named entry in `/`, so `<acct>/packages/x` means the same thing either way. It's added only if the root folder has no entry by that name. Removing or renaming the link changes only the view.
2. **Status belongs to the document, not the folder.**
   - `ModuleWatcher.packageStatus(urlOrDocumentId)` returns `{ state: "loading" | "loaded" | "failed", error?, plugins?: string[] }`, or undefined for anything that isn't a package.
   - The watcher dispatches a `"status"` event when one changes. It's an `EventTarget`.
   - Rows read it late-bound through `globalThis.patchwork?.packages`, and look as they do today when it's missing.
3. **A row's live path is built from the names walked from the root folder.**
   - Each `DocumentList` passes `names` down.
   - The acctHash is idhash(account documentId), copied into sideboard (SHA-256, first 12 bytes, base58, about 15 lines), since tools can't import across repos at build time.
   - The account comes from `globalThis.patchwork?.account`. A panel whose folder isn't that account's `rootFolderUrl` opens without a path.
4. **`selected-view` carries `path`.** threepane passes it to `<patchwork-view path>` on the main view. On boot, the provider reads `path=` raw from the hash, since `URLSearchParams` decodes `%2F`.

## Tasks

### system

- [ ] **S1: Package status on the ModuleWatcher.** Test (`module-watcher.test.ts`):
  - a package goes `loading` → `loaded` with its plugin ids;
  - a failing one goes to `failed` with the error;
  - `"status"` fires;
  - an http module has no status.

  Implement: a `#status` map keyed by documentId, updated in `announce`. `importPackageSafe` returns the error instead of swallowing it.
- [ ] **S2: The root-folder `packages` link.** Test (`migrate-packages.test.ts`):
  - `createDefaultAccount` adds `{ name: "packages", type: "folder", url: <packages folder> }` to the root folder;
  - migration adds it when there's no `packages` entry, and leaves an existing one alone.
- [ ] **S3: Changeset**, then build, test (by exit code), and commit.

### base (`paths` branch)

- [ ] **B1: providers.** `SelectedView.path`, set from `detail.path` and from the raw `path=` in the hash on boot. Test it.
- [ ] **B2: threepane.**
  - `MainDocumentView` sets `path` on the main `<patchwork-view>`.
  - The account bar's Packages button shows only when `/packages` isn't bound; the namespace is read from the account doc the frame already holds.
  - Test the bar.
- [ ] **B3: sideboard paths.**
  - `DocumentList` threads `names`.
  - Rows and folders open with `path` when the panel is the account's root.
  - `idhash` gets a known-vector test.
  - Test that a nested row's open event carries `<acctHash>/a/b`.
- [ ] **B4: sideboard status.**
  - A row whose document has a package status shows a dot (`data-package-state`) with a tooltip.
  - It re-renders on `"status"`.
  - Test it with a fake `globalThis.patchwork.packages`.
- [ ] **B5: Remove the Packages section** from `sideboard.tsx`, and `account-bar.tsx`'s use of it. threepane inlines its own bar, and `chee/account-bar` stays as it was. Keep the panel's menu-scoping fix, which still matters for two list widgets.
- [ ] **B6: Build, test and lint** each touched tool, then commit and push `paths`.
