# Paths phase 3: routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking into a document can say where it was opened from: the live path lands in `&path=` in the hash, a hash with only `&path=` opens what the path names, and a `doc=` that disagrees with its `path=` wins.

**Architecture:** Bring in the `open-document-path` branch (48f4ab98), which threads `path` through the `patchwork:open-document` event, `patchwork.open` and `<patchwork-view path>`. Then redefine that `path` as the **live path** (`<acctHash>/Projects/foo`), not a service worker path. The router reads and writes `path` raw, since its segments are already percent-encoded, and resolves it with `resolveLivePath` from phase 1.

**Tech Stack:** TypeScript; `core/patchwork/src/router.ts`; `@inkandswitch/patchwork-filesystem` (`idhash`, `resolveLivePath`); vitest in node against a fake `window`, `location` and root element.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, section 3, *Hash routing* and *Opening at a path*.

## Global Constraints

- `path` joins `HASH_KEY_ORDER` right after `doc`. Each segment is `encodeURIComponent`-encoded and the slashes stay literal: the value goes into the hash exactly as `livePath` wrote it.
- `doc=` says what is open; `path=` says where it was opened from.
- A hash with `path=` and no `doc=` resolves the path and opens the result.
- If `doc=` and `path=` disagree, `doc=` wins and `path=` is dropped with a console warning.
- `patchwork:open-document`'s `path` holds the live path, and the router writes it to `&path=`. That reverses the branch's choice to keep it out of the hash.
- `<patchwork-view path>` hands the path to the tool without remounting, as on the branch.

## Decisions this plan makes

1. **`path` is read raw from the hash.** `URLSearchParams` decodes `%2F` to `/`, which would split a name containing a slash into two. A single `parseHashParams(hash)` reads every key through `URLSearchParams` and then puts `path`'s raw text back. Every place the router reads the hash uses it.
2. **The router resolves only the signed-in account's paths.** Its `accounts` map is the account doc's own acctHash. A path under any other account doesn't resolve: it's dropped with a warning if there's a `doc=`, or ignored if there isn't.
3. **The agreement check runs after the document is opened**, so a slow path lookup never delays opening it. If the path names a different document, or none at all, the router rewrites the hash without `path=`.
4. **The router is tested in node.** `@inkandswitch/patchwork-elements` is mocked down to an `openDocument` that dispatches the event, and the DOM is replaced with small fakes: an `EventTarget` with attributes, plus `window`, `location` and `document`.

## Review Focus

- **Reserved characters in a path segment** (`a%2Fb`, `%26`, `%23`, a space as `%20`, `+`) survive a round trip through the hash, including through an open-document event that re-serializes the other params. Pinned in Task 2.
- **Path only, unresolvable** (a typo, another account): no exception, a warning, and no document opened. Pinned in Task 3.
- **The same `path=` arriving again on every hashchange** doesn't re-open anything or loop. Only a hash without `doc=` opens from the path. Pinned in Task 3.

---

### Task 1: Bring in `open-document-path`, as a live path

**Files:** cherry-pick 48f4ab98 (`core/elements/src/{events,index,patchwork-view}.ts`, `core/patchwork/src/{index,types}.ts`, `.changeset/open-document-sw-path.md`). Then edit the doc comments and the changeset.

- [ ] **Step 1:** `git cherry-pick 48f4ab98`. Expected: it applies cleanly, since those files aren't touched on `paths-design`. Verify with `git diff HEAD~1 --stat`.
- [ ] **Step 2: Redefine `path`.**
  - `OpenDocumentEventDetail.path` becomes: "The live path the document was opened at, like a cwd: `<acctHash>/Projects/foo`, each segment `encodeURIComponent`-encoded. The router writes it to `&path=`."
  - Point the `OpenOptions.path` and `PatchworkViewElementBase.path` comments at it.
  - Rewrite the changeset (rename it `open-document-path.md`) to say the same, listing `@inkandswitch/patchwork-elements` and `@inkandswitch/patchwork`.
- [ ] **Step 3: Typecheck:** `pnpm --filter @inkandswitch/patchwork-elements build && pnpm --filter @inkandswitch/patchwork exec tsc --noEmit`. Expected: no errors.
- [ ] **Step 4: Commit** `elements: open-document's path is the live path it was opened at`.

### Task 2: Hash params keep `path` raw

**Files:** create `core/patchwork/src/hash-params.ts` (moving `serializeHashParams`, `HASH_KEY_ORDER`, `RAW_HASH_KEYS` and `docParamToUrl` out of `router.ts`); modify `router.ts` to import them. Test `core/patchwork/test/hash-params.test.ts`.

**Interfaces:**
```ts
export const HASH_KEY_ORDER = ["doc", "path", "tool", "type", "title", "frame", "draft"];
/** `URLSearchParams` over a hash, except that `path`'s value is its raw, still-encoded text. */
export function parseHashParams(hash: string): URLSearchParams;
export function serializeHashParams(params: URLSearchParams): string; // doc, draft and path emitted raw
export function docParamToUrl(docParam: string | null): AutomergeUrl | undefined; // moved unchanged
```

- [ ] **Step 1: Failing tests**

```ts
it("keeps a path's segments as they're encoded", () => {
  const hash = "doc=automerge:abc&path=acct/a%2Fb/x%26y/%23z/my%20notes/1%2B1";
  expect(parseHashParams(hash).get("path")).toBe("acct/a%2Fb/x%26y/%23z/my%20notes/1%2B1");
  expect(serializeHashParams(parseHashParams(hash))).toBe(hash);
});
it("puts path right after doc", () => {
  const params = new URLSearchParams({ tool: "t", doc: "automerge:abc" });
  params.set("path", "acct/x");
  expect(serializeHashParams(params)).toBe("doc=automerge:abc&path=acct/x&tool=t");
});
it("reads a hash with no path as before", () => {
  expect(parseHashParams("doc=automerge:abc&title=a%20b").get("title")).toBe("a b");
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @inkandswitch/patchwork exec vitest run test/hash-params.test.ts`.
- [ ] **Step 3: Implement.** Use `parseHashParams` in place of `new URLSearchParams(hash)` everywhere in `router.ts`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `patchwork: hash params keep a path's encoding`.

### Task 3: The router writes, opens from, and checks `path=`

**Files:** `core/patchwork/src/router.ts`; tests `core/patchwork/test/router.test.ts`.

**Interfaces:**
- `createRouter` is unchanged on the outside. Internally it:
  - computes `accounts = new Map([[await idhash(accountDocHandle.documentId), accountDocHandle.url]])` once;
  - in the open-document listener, sets `path` from `detail.path`, or deletes it if there's none;
  - in `route()`, for a hash with `path` and no `doc`: `resolveLivePath(repo, path, { accounts })`. If that finds a document, it dispatches `patchwork:open-document` with `{ url: handle.url, path }`; if not, it warns and rewrites the hash without `path`;
  - in `route()`, for a hash with both: dispatches open-document as now, with `path` in its detail. Then it resolves the path, and if the result's `documentId` differs from `doc`'s, or nothing resolves, it warns and rewrites the hash without `path`.

- [ ] **Step 1: Failing tests** (fake DOM, real in-memory `Repo`, an account whose `/` holds `Projects/foo/notes`)

```ts
it("writes an opened document's path to the hash", ...)
  // dispatch open-document {url: notes.url, path: livePath(a, ["Projects","foo","notes"])} → location.hash has doc=…&path=<that>
it("drops path from the hash when a document is opened without one", ...)
it("opens what a path names when the hash has no doc", ...)
  // location.hash = `path=${live}`; await router.route() → an open-document event with url === notes.url and path === live
it("warns and drops a path that names nothing, opening nothing", ...)
it("keeps a path that agrees with doc", ...)
it("drops a path that disagrees with doc, keeping doc", ...)    // console.warn called; hash keeps doc, loses path
it("doesn't open anything twice when the same path arrives with its doc", ...)
  // hash doc=notes&path=live → route() → exactly one open-document event
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @inkandswitch/patchwork exec vitest run test/router.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the patchwork suite, expect PASS:** `pnpm --filter @inkandswitch/patchwork test`, plus `pnpm --filter @inkandswitch/patchwork exec tsc --noEmit`.
- [ ] **Step 5: Commit** `patchwork: route &path= — write it, open from it, drop it when it disagrees`.

### Task 4: Changeset

- [ ] Add `.changeset/paths-routing.md` (`@inkandswitch/patchwork: patch`) describing `&path=`: written when a document is opened at a path, opened from when there's no `doc=`, and dropped with a warning when it disagrees. The e2e test the spec lists ("open a document with `&path=` alone") needs a full-UI boot. Add it to `packages/e2e/tests/content-store.spec.ts`'s Chromium-only pattern as `path-routing.spec.ts`, typecheck it, and let CI run it.
- [ ] Commit `changeset: path routing; e2e: open with &path= alone`.
