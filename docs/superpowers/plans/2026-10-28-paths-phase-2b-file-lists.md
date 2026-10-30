# Paths phase 2b: pinned URLs name their file list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework phase 2 so a pinned `/@/` URL is checked against itself. The last container step carries `~<listHash>`, the hash of a canonical file list. The service worker checks the list against the URL and the bytes against the list, and trusts nothing in between.

**Architecture:**
- `patchwork-filesystem` learns three things:
  - the `~listHash` grammar;
  - how to build a file list (`buildFileList`);
  - how to read a file at the heads a list recorded (`readPath` with `heads`).
- `pinPath` returns the URL and the list it names.
- The bootloader's request flow (`servePinned`) is rewritten around lists.
- Resolvers answer three kinds of request:
  - a live path: a 307, whose body is the one-file list;
  - a pinned file at given heads: its bytes;
  - a container: its full list.
- The in-memory index, the worker's manifests and the authenticated `/@/.index` channel are deleted.

**Tech Stack:** As in phase 2. TypeScript; automerge-repo 2.6.0-subduction.48; Cache Storage; `crypto.subtle`; vitest in node, including the service worker harness (`core/bootloader/test/service-worker-harness.ts`).

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`, revised in f9446695. Section 1 covers the `~listHash` grammar and rule 4; section 5 covers *File lists*, *What gets stored*, *Request flow* and *Who is trusted for what*. The plan being reworked is `docs/superpowers/plans/2026-10-28-paths-phase-2-service-worker.md`.

## Global Constraints

- The pinned container step is `<idhash>@<heads>~<listHash>`. `listHash` is SHA-256 of the list's bytes, in base64url without padding: the same function as content (`contentHash`).
- A list is canonical JSON: keys sorted at every level, no whitespace.
  - Shape: `{"files":{"<tail>":{"heads"?:"a.b","sha256":"…","store":bool,"type":"…"}},"v":1}`.
  - `heads` is absent for a value inside the container.
  - The container itself is the tail `""`.
- No document ids in lists or URLs (except a share root).
- Store a list if and only if every entry in it has `store: true`. Otherwise the service worker keeps it in memory.
- What gets stored is unchanged: unprotected documents, or protected ones reached through `/packages`, never under a share root.
- `pinPath` lists every file under the last container. A live → pinned redirect lists only the file asked for. A tail a list doesn't cover answers 404.
- A container step without a list leads to files served live: `no-store`, unstored, unchecked.
- Request flow, exactly as the spec's section 5. A list or bytes that don't match fail as a network error, and the service worker never stores anything that doesn't match.
- Phases 1 and 2 aren't released, so their changesets are rewritten, not added to.
- No local e2e, `vite preview` or site builds.

## Decisions this plan makes

1. **Hashing moves to filesystem** (`core/filesystem/src/content-hash.ts`: `contentHash`, `toBytes`). `pinPath` needs it, and the bootloader imports it from there. The bootloader's `content-hash.ts` is deleted.
2. **Keyhive protection moves to filesystem too:** `isKeyhiveDocumentId(documentId)`. `@inkandswitch/patchwork-plugins`'s `isKeyhiveDoc` calls it, so the rule lives once.
3. **`pinPath` and `pinnedPath` return `{ url | path, list }`** instead of a string. They're unreleased phase 1 API.
4. **A live → pinned 307 carries the one-file list as its body.** The service worker hashes it, keeps it if it matches the `~listHash` in `Location` (stored or in memory, by the rule above), and serves the 307 without the body. A list `pinPath` builds for imports (phase 4) is handed over the same way. Phase 4 adds the store write, or a message to the service worker; nothing calls it before then.
5. **Rebuilding a missing list** is a handoff with `request.list = true` on the container's pinned path, without `~`. The resolver answers the full list's bytes. Only a list that hashes to the URL's `listHash` is kept.
6. **Key normalization changes.** `normalizePinned` returns candidates of `{ listHash?, prefix, tail }`, latest doc-step-shaped segment first, as before, plus the share-root fix the review deferred. The first candidate that has a `listHash` is used.
7. **The worker keeps account registration**, since it still resolves paths for bytes and lists. Manifests, `index-channel.ts`, `INDEX_ANSWER_PATH`, the Firefox probe and the `/@/.index` route are deleted. `AUTOMERGE_WORKER_PATH` stays as `setup.ts`'s default.

## Review Focus

- **A file changed after pinning:** the pinned URL still serves the old bytes. The resolver reads the file at the list's `heads`, and they match the list. Pinned in Task 2 (`readPath` with `heads`) and Task 5 (the harness round trip).
- **A list in the store forged or truncated:** it's deleted and rebuilt. With nothing changed the rebuild matches; with something changed, the request fails as a network error, and no forged bytes are ever served. Pinned in Tasks 3 and 5.
- **Canonical bytes:** the same files in a different insertion order give the same `listHash`. Pinned in Task 2.
- **A redirect's one-file list:** a sibling requested under it answers 404, not someone else's bytes. Pinned in Task 3.
- **No document ids:** the list bytes contain no documentId. Pinned in Task 2.

---

## File structure

| File | Change |
|---|---|
| `core/filesystem/src/paths.ts` | `DocStep.listHash?`, `docStep(idhash, heads, listHash?)`, parse `~` |
| `core/filesystem/src/content-hash.ts` (create) | `contentHash`, `toBytes`, `isKeyhiveDocumentId` |
| `core/filesystem/src/file-list.ts` (create) | `FileList`, `FileEntry`, `canonicalJson`, `buildFileList` |
| `core/filesystem/src/walk.ts` | the walk keeps `~listHash` and exposes `container.listHash` and `tail`; `readPath(…, { heads })`; `pinPath`/`pinnedPath` return the list |
| `core/plugins/src/keyhive.ts` | `isKeyhiveDoc` via `isKeyhiveDocumentId` |
| `core/bootloader/src/pinned.ts` | candidates with `listHash`; `servePinned` rewritten; manifest functions deleted |
| `core/bootloader/src/resolver.ts` | heads reads, `list` requests, a 307 with its list |
| `core/bootloader/src/types.ts` | `HandoffRequest.heads?`, `HandoffRequest.list?`; manifest/index types deleted |
| `core/bootloader/src/service-worker.ts` | wiring; index, manifests and `/@/.index` deleted |
| `core/bootloader/src/automerge-protocol-handler.ts` | manifest wiring deleted |
| delete | `core/bootloader/src/{manifest,index-channel,content-hash}.ts` and their tests |
| `packages/e2e/tests/content-store.spec.ts` | drop the forged-answer test |
| `.changeset/paths-*.md` | rewrite |

---

### Task 1: Grammar and walk carry `~listHash`

**Files:** `core/filesystem/src/paths.ts`, `src/walk.ts`; tests `test/paths.test.ts`, `test/walk.test.ts`.

**Interfaces:**
- Produces:
  - `DocStep = { kind: "doc"; idhash; heads; listHash?: string; raw }`.
  - `docStep(idhash, heads, listHash?)`.
  - `parsePath` reads `<base58>@<heads>~<base64url>`: `/^[A-Za-z0-9_-]+$/` after the `~`, and a `~` with nothing after it is a syntax error for the root and a name otherwise.
  - `WalkEnd.container` gains `listHash?: string`. The walk writes a matched doc step back with its `listHash`, so re-pinning a listed path gives the same string.
  - `WalkEnd.tail: string`: the encoded names after the container, joined with `/`.

- [ ] **Step 1: Failing tests**

```ts
// paths.test.ts
it("reads a doc step's file list hash", () => {
  expect(parsePath("acct@h/foo@h~AbC-_9/dist/x.js").segments[0]).toEqual({
    kind: "doc", idhash: "foo", heads: ["h"], listHash: "AbC-_9", raw: "foo@h~AbC-_9",
  });
  expect(docStep("foo", ["b", "a"], "L")).toBe("foo@a.b~L");
});
// walk.test.ts
it("keeps a container's list hash and says which tail follows it", async () => {
  // pinned = (await pinnedPath(repo, live(packages/foo), {accounts}))!.path, then append "~L" by hand
  // walkPath(`${pinned}~L/dist/index.js`) → container.listHash "L", tail "dist/index.js",
  // pinned === `${pinned}~L/dist/index.js`, canonical true
});
```

- [ ] **Step 2: Run, expect FAIL** (`listHash` undefined): `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/paths.test.ts test/walk.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the filesystem suite, expect PASS:** `pnpm --filter @inkandswitch/patchwork-filesystem test`
- [ ] **Step 5: Commit** `filesystem: doc steps carry a file list hash`

### Task 2: File lists, reading at heads, `pinPath` returns the list

**Files:** create `core/filesystem/src/content-hash.ts` and `src/file-list.ts`; modify `src/walk.ts`, `src/index.ts` and `core/plugins/src/keyhive.ts`; test `test/file-list.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // content-hash.ts
  export function toBytes(content: string | Uint8Array): Uint8Array;
  export function contentHash(bytes: Uint8Array): Promise<string>;   // moved from bootloader, same output
  export function isKeyhiveDocumentId(documentId: DocumentId): boolean;
  // file-list.ts
  export type FileEntry = { sha256: string; type: string; heads?: string; store: boolean };
  export type FileList = { v: 1; files: Record<string, FileEntry> };
  export function canonicalJson(value: unknown): string;
  export function parseFileList(bytes: Uint8Array): FileList | undefined;
  /** The list for the container `path` is in (all its files, or only `only`'s tails), its bytes, hash, and the container's pinned path without `~`. */
  export function buildFileList(repo: Repo, path: string, options: WalkOptions & {
    findFile?: WalkOptions["find"]; only?: string[]; isProtected?: (id: DocumentId) => boolean;
  }): Promise<{ prefix: string; list: FileList; bytes: Uint8Array; listHash: string; missing: string[] } | undefined>;
  // walk.ts
  export function readPath(repo, path, options: WalkOptions & { heads?: UrlHeads }): …  // heads: read the final doc at these
  export function pinnedPath(repo, path, options): Promise<{ path: string; list: Uint8Array } | undefined>;
  export function pinPath(repo, path, options): Promise<{ url: string; list: Uint8Array } | undefined>;
  ```
- `buildFileList` uses `listFiles` (phase 2), drops `documentId` from each entry, and records `heads` (`formatHeads` of the heads the file doc was read at) for files reached by a link. `ListedFile` gains `heads?: UrlHeads`. `store` follows the spec rule, with `isProtected` defaulting to `isKeyhiveDocumentId`.
- `pinnedPath` builds the full list for the container the path ends in, or the one-file list when called with `{ only: [tail] }`, and writes `~listHash` on that container's step.

- [ ] **Step 1: Failing tests**

```ts
it("is canonical: the same files in another order hash the same", ...)
  // two directory docs with the same keys inserted in opposite order and equal file contents/heads? — use one doc,
  // build twice → identical bytes; canonicalJson({b:1,a:{d:1,c:2}}) === '{"a":{"c":2,"d":1},"b":1}'
it("records each file's hash, type and heads, and no document ids", ...)
  // bytes as text contains no documentId of any fixture doc; entry for dist/index.js has heads === formatHeads(file.heads())
it("lists only what it's asked to", ...)          // only: ["dist/index.js"] → keys ["dist/index.js"]
it("stores protected content only through /packages", ...)  // as phase 2's manifest test
it("reads a file at the heads its list recorded, after it changed", async () => {
  // pin; change the file doc's content; readPath(pinned path, {heads: parseHeads(entry.heads)}) → old content
});
it("pins a path with its container's list hash", ...)
  // pinnedPath(live packages/foo/dist/index.js) → path ends `~${await contentHash(list)}/dist/index.js`
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/file-list.test.ts`
- [ ] **Step 3: Implement.** Update existing callers of `pinnedPath` and `pinPath` in the filesystem tests and in `core/bootloader/src/resolver.ts` (it reads `.path`).
- [ ] **Step 4: Run the filesystem suite and typecheck the dependents, expect PASS:** `pnpm --filter @inkandswitch/patchwork-filesystem test && pnpm --filter @inkandswitch/patchwork-filesystem --filter @inkandswitch/patchwork-plugins build && pnpm --filter @inkandswitch/patchwork-bootloader exec tsc --noEmit`
- [ ] **Step 5: Commit** `filesystem: file lists, reading at recorded heads, pinPath names its list`

### Task 3: The request flow around lists (bootloader, pure)

**Files:** `core/bootloader/src/pinned.ts`, `src/types.ts`; tests `test/pinned.test.ts`. Delete `src/manifest.ts`, `src/index-channel.ts`, `src/content-hash.ts` and their tests. Change imports to `@inkandswitch/patchwork-filesystem`.

**Interfaces:**
- Produces:
  ```ts
  export type Candidate = { prefix: string; tail: string; listHash?: string };
  export function normalizePinned(path: string):
    { candidates: Candidate[]; acctHash?: string; pinned: boolean; share: boolean } | undefined;
  export type PinnedDeps = {
    lists: Map<string, FileList>;            // in memory, by listHash
    store: ContentStore | undefined;
    hash(bytes: Uint8Array): Promise<string>;
    /** Ask for the full list of the container at `prefix`; its bytes, or undefined. */
    buildList(prefix: string): Promise<Uint8Array | undefined>;
    /** Ask for the file at `path`, read at `heads` if given. */
    resolve(path: string, heads?: string): Promise<{ body: Uint8Array; contentType: string } | Response | undefined>;
    warn(message: string): void;
    keep(work: Promise<unknown>): void;
  };
  /** Check `bytes` against `listHash` and keep the list: stored if every entry allows it, else in memory. False if it doesn't match. */
  export function keepFileList(bytes: Uint8Array, listHash: string, deps: PinnedDeps): Promise<boolean>;
  export function servePinned(normalized: { candidates: Candidate[] }, deps: PinnedDeps): Promise<Response>; // throws PinnedAbort
  ```
- `handoffRequest(request, cachename, to: URL | { path: string; heads?: string; list?: boolean })`.
- Flow: the spec's *Request flow for a pinned URL*. A candidate with no `listHash` anywhere is served live through `resolve(path)`: `no-store`, unchecked. Concurrent `buildList` calls for one `listHash` share a request (`sharedRequests(fn)`, keyed by its argument).

- [ ] **Step 1: Failing tests** (fake store, real `contentHash`, lists built with `canonicalJson`)

```ts
it("serves a file whose list and bytes are in the store, asking no resolver", ...)
it("deletes a forged list, rebuilds it, and serves", ...)          // store has garbage under listHash; buildList returns real bytes
it("fails when the rebuilt list doesn't match the URL", ...)       // buildList returns a different list → PinnedAbort
it("deletes a forged file, rereads it at the list's heads, and serves", ...) // resolve called with entry.heads
it("fails on a resolver's bytes that don't match, storing nothing", ...)
it("answers 404 for a tail the list doesn't cover", ...)
it("keeps a list in memory when an entry may not be stored", ...)  // keepFileList → lists has it, store empty
it("serves a path with no list live and unchecked", ...)           // cache-control no-store
it("normalizes a share root's doc-step-shaped name", ...)          // the deferred review minor
it("shares one rebuild among concurrent requests", ...)
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @inkandswitch/patchwork-bootloader exec vitest run test/pinned.test.ts`
- [ ] **Step 3: Implement**, and delete the manifest and index-channel code.
- [ ] **Step 4: Typecheck, expect a clean run.** Expect errors only in `service-worker.ts`, `resolver.ts` and `automerge-protocol-handler.ts`, which Tasks 4–5 fix. Run the pinned tests, expect PASS.
- [ ] **Step 5: Commit** `bootloader: check pinned URLs against their own file list`

### Task 4: Resolvers answer lists and reads at heads; the worker sheds manifests

**Files:** `core/bootloader/src/resolver.ts`, `src/automerge-protocol-handler.ts`, `src/types.ts`; test `test/resolver.test.ts`.

**Interfaces:**
- `HandoffRequest.heads?: string` and `HandoffRequest.list?: boolean`, both additive.
- `answer()` for a `path`:
  - **`list`:** `buildFileList(path)`, which must be canonical. Answers `200 application/json` with the list's bytes, or 404.
  - **`heads`:** `readPath(path, { heads: parseHeads(heads) })` → 200 with the bytes.
  - **Live, or not canonical:** `pinnedPath(path, { only: [tail] })` → 307. `Location` is `/@/` plus the pinned path, and the body is the one-file list.
  - **Canonical pinned, no heads:** the bytes, as now.
- The worker: drop `createManifestHandler` and the `manifest` channel branch. Keep `register-account`.

- [ ] **Step 1: Failing tests**

```ts
it("answers a live path with a 307 whose body is the list it names", ...)
  // contentHash(body) === the ~listHash in location; parseFileList(body) has one entry
it("answers a container's full list", ...)
it("reads a file at given heads, after it changed", ...)
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS:** `pnpm --filter @inkandswitch/patchwork-bootloader exec vitest run test/resolver.test.ts`
- [ ] **Step 5: Commit** `bootloader: resolvers answer file lists and reads at heads`

### Task 5: Service worker wiring, through the harness

**Files:** `core/bootloader/src/service-worker.ts`; test `test/service-worker.test.ts`.

**Interfaces:**
- `servePath`:
  - Live → `handoff({ path })`. On a 307 with a body, `keepFileList(body, listHash from location)`, then serve the 307 without the body.
  - Pinned → `servePinned` with:
    - `buildList = handoff({ path: prefix, list: true })`;
    - `resolve = handoff({ path, heads })`;
    - `lists`: a module-level `Map`.
- Delete: `contentIndex`, manifest requests, `settleIndexAnswer`, `answerIndex`, the `/@/.index` route, and the manifest re-broadcast on `online`.

- [ ] **Step 1: Failing harness tests** (a fake tab running the real resolver, a real in-memory Repo, an account registered in the tab)

```ts
it("redirects a live path, then serves the pinned file from its list", ...)
  // fetch live → 307; fetch location → bytes; content store now holds the list and the bytes
it("serves the old bytes for a pinned URL after the file changed", ...)
it("never serves a forged store entry", ...)
  // put forged bytes under the file's sha256 → fetch again → real bytes
it("fails, rather than serving, when a tab answers with other bytes", ...)
  // swap the tab's postMessage to answer with forged bytes → event.response() rejects
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS:** `pnpm --filter @inkandswitch/patchwork-bootloader test`, plus `pnpm --filter @inkandswitch/patchwork exec tsc --noEmit` after building filesystem, plugins and bootloader.
- [ ] **Step 5: Commit** `service worker: serve pinned paths checked against their file list`

### Task 6: e2e, changesets, cleanup

- [ ] **Step 1:** In `packages/e2e/tests/content-store.spec.ts`, delete the forged-answer test. The forged-store test stays as is, since the live → 307 → pinned flow still holds. Typecheck: `pnpm --filter @inkandswitch/patchwork-e2e exec tsc --noEmit`.
- [ ] **Step 2: Rewrite `.changeset/paths-content-store.md`** for what ships:
  - `/@/` paths, file lists, the store;
  - `registerAccount` and `clearAccountStore`;
  - no index and no answer channel.
  
  Rewrite `.changeset/paths-grammar-providers.md` for `pinPath` and `pinnedPath` now returning `{ url | path, list }`. Add `@inkandswitch/patchwork-plugins` for `isKeyhiveDoc` now going through filesystem.
- [ ] **Step 3: Run the full suites and lint.** `pnpm --filter @inkandswitch/patchwork-filesystem --filter @inkandswitch/patchwork-bootloader test` should pass. In `pnpm lint`, ignore hits under the git-ignored `sites/bench/bench-results`.
- [ ] **Step 4: Commit** `content store: changesets and e2e for file lists`
