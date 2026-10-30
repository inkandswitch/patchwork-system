# Paths phase 2: service worker, content store, index — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service worker serves `/@/` URLs: live ones redirect (307) to their pinned form, and pinned ones come from a content-addressed store. Every read from that store is checked against an index that only the automerge worker can fill.

**Architecture:**
- `patchwork-filesystem` learns to read one file at a path (`readPath`) and to list every file under a pinned document (`listFiles`).
- The bootloader gets four small modules the service worker wires together, unit-tested under vitest:
  - `content-hash.ts`: the one hash function.
  - `content-store.ts`: the store.
  - `pinned.ts`: key normalization, the index, and the request flow.
  - `index-channel.ts`: checks who sent an answer and posts answers.
- The automerge worker builds manifests (`manifest.ts`) and answers them with an authenticated `fetch()`.
- Resolvers, in tabs and in the worker, stop writing the cache. They return bytes and the service worker decides what to keep.

**Tech Stack:** TypeScript; `@automerge/automerge-repo` 2.6.0-subduction.48; the service worker and Cache Storage APIs; `crypto.subtle`; `isUnprotectedDocId` from `@automerge/automerge-repo-keyhive`; vitest in node; Playwright e2e and bench in CI only.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`. This plan covers section 3 *URLs*, section 5 in full, and **Implementation phases → 2**. Read the spike results under *Spikes before planning*: they decide the channel. Phase 1's plan is `docs/superpowers/plans/2026-10-28-paths-phase-1-grammar-providers-namespace.md`, and its walker is in `core/filesystem/src/walk.ts`.

## Global Constraints

- Store: a CacheStorage cache named `patchwork-content-<acctHash>`. Key `/.content/<sha256 base64url>`, on this origin, never fetched. Value: the bytes only.
- Store reads and writes go through `get(hash)` / `put(hash, bytes)` (plus `delete(hash)`), so they can be encrypted later.
- Index: a `Map` in service worker memory from pinned URL to `{ sha256, contentType }` (plus `store`; see Decisions). Only the automerge worker fills it.
- A store hit is hashed with `crypto.subtle` SHA-256 **on every read**. A mismatch deletes the entry, warns loudly, and goes back to a resolver.
- Bytes a resolver returns are hashed in the service worker:
  - matching the index entry: serve, and store if the entry allows;
  - not matching: a network error, nothing stored;
  - no index entry (no automerge worker): serve inline, store nothing.
- What gets stored: content from unprotected documents (`isUnprotectedDocId`), and keyhive-protected content only when it's reached through `/packages`.
- Index answers count only from a `Client` with `type === "sharedworker"` and the automerge worker's script URL. The worker sends them as `fetch()` requests to a reserved path, and the service worker looks up `event.clientId`. Requests may ride the BroadcastChannel.
- A live `/@/` URL answers 307 to its pinned form. A pinned URL never redirects.
- Legacy `/automerge%3A…/` URLs keep working, keyed by URL and unchecked.
- `clearAccountStore(acctHash)` deletes the account's store.
- Stale workers outlive deploys, so `HANDOFF_CHANNEL` messages and handoff replies only change additively (`core/bootloader/src/types.ts`, `HandoffRequest`).
- No local e2e, `vite preview` or shell builds. Unit tests and typechecks only; CI runs the rest.

## Decisions this plan makes that the spec leaves open

1. **The worker's script URL is fixed, not hashed.** The vite plugin serves `/automerge-protocol-handler-worker.js` under that name in every build (`core/patchwork/src/vite/service-worker-plugin.ts`, `workers`). The service worker compares the client's origin and pathname with a constant `AUTOMERGE_WORKER_PATH`, and ignores the query. A site that overrides `workerPath` in `setupServiceWorker` gets its answers rejected: everything is then served inline and nothing is stored. The spec's word "hashed" is corrected in Task 9.
2. **Answers go to `POST /@/.index`.** `.` isn't base58, so it can't be an acctHash. The service worker replies `204` with `x-patchwork-index: accepted`. A reply without that header means the fetch skipped the service worker, as the spike saw in Firefox. The worker then retries 5 times, 200ms apart.
3. **Manifest requests ride `HANDOFF_CHANNEL`** as a new message type, `manifest`. Old workers ignore it, since they only read `type: "request"`.
4. **The manifest covers the last document the URL enters at its heads.** Its entries are keyed by the tail (the names after the last doc step, each `encodeURIComponent`'d, joined with `/`). The document itself is the empty tail `""`. Containers below it aren't listed: they have their own doc steps. The worker returns the **canonical** prefix, and the service worker indexes `prefix + (tail ? "/" + tail : "")`. If the prefix the service worker guessed isn't canonical (a name that looks like a doc step), the request misses the index and is served inline, unstored. That's safe.
5. **The store flag is the worker's call**, made per entry:
   - `store = rootIsAccount && (unprotected(contentDocId) || prefixSegments[1] === "packages")`.
   - A share root (`automerge:<id>@h`) never stores.
6. **The tab tells its account to the resolvers.** `registerAccount(url)` in the bootloader adds the account to the tab's own resolver and posts `{ type: "register-account", url }` to the automerge worker. It posts again whenever the worker respawns. The worker computes the acctHash itself, so a tab can't map a hash to the wrong document. This settles phase 1's carry-over "the accounts map isn't checked".
7. **Waiting for documents moves into the walk.** `WalkOptions` gains `find?: (url, heads?) => Promise<DocHandle>`. The bootloader passes one that waits for heads (pinned) or for peers to catch up (live), within the resolver's 30s signal. This settles phase 1's carry-over "no signal / waitForHeads".
8. **Legacy replies are inline.** For `automerge:` URLs the resolver now always answers `type: "response"`. The service worker caches it by URL itself when it's immutable (status 200/203/204, no `no-store`). The service worker still accepts `type: "cached"` from older workers.
9. **The manifest wait is bounded at 10s** (`MANIFEST_TIMEOUT_MS`). After that the request is served as if there were no worker.
10. **Cold start cost, accepted and measured.** The index lives in memory, so after a browser restart every package needs a manifest, and building one loads and hashes every file document in the package. Today the URL-keyed cache serves those without loading any document. Task 8's bench measures it. If it's too slow, persisting manifests is the follow-up, and it reopens a gap. That trade-off isn't this plan's to make.

## Review Focus

- **Request URL spellings:** browsers send `@`, `:` and non-ASCII in path segments in different encodings (`a@b.js` vs `a%40b.js`, `日本` vs `%E6%97%A5%E6%9C%AC`). Every spelling of one file must hit one index key. Pinned in Task 3 (`normalizePinned`).
- **The service worker stops mid-session:** the index is empty again and the worker's LRU answers. Content is identical, nothing is re-stored that was already there, and no request hangs. Pinned in Task 3 (fresh index, warm store).
- **No worker, or a worker that is slow to boot:** the manifest times out, the request is served inline within the timeout, and nothing is stored. Pinned in Task 3.
- **Many files of one package requested at once:** exactly one manifest request. Pinned in Task 3.
- **Non-ASCII string content:** the worker hashes the same UTF-8 bytes the service worker receives. Pinned in Task 4.

---

## File structure

| File | Responsibility |
|---|---|
| `core/filesystem/src/walk.ts` (modify) | `WalkOptions.find`; module-level idhash memo; `readPath`; `listFiles` |
| `core/filesystem/src/providers.ts` (modify) | `accountBindings` memoized per doc object, warning once per bad mount |
| `core/filesystem/src/resolve.ts` (modify) | export `materialize` for `walk.ts` |
| `core/bootloader/vitest.config.ts`, `core/bootloader/test/setup.ts` (create), `package.json` (modify) | test infra (same shape as `core/filesystem`) |
| `core/bootloader/src/content-hash.ts` (create) | `contentHash(bytes)`, `toBytes(content)` |
| `core/bootloader/src/content-store.ts` (create) | `ContentStore`, `cacheStore`, `contentCacheName`, `clearAccountStore` |
| `core/bootloader/src/pinned.ts` (create) | `normalizePinned`, `indexManifest`, `servePinned` |
| `core/bootloader/src/index-channel.ts` (create) | `AUTOMERGE_WORKER_PATH` check, `acceptIndexAnswer`, `postIndexAnswer` |
| `core/bootloader/src/manifest.ts` (create) | `buildManifest`: the worker's side |
| `core/bootloader/src/types.ts` (modify) | `Manifest`, `IndexEntry`, `ManifestRequestMessage`, `IndexAnswer`, `HandoffRequest.path`, `RegisterAccountMessage` |
| `core/bootloader/src/resolver.ts` (modify) | answers `path` requests (307 or bytes), legacy inline, no `cache.put`, `find` with waits |
| `core/bootloader/src/tab-resolver.ts`, `setup.ts` (modify) | `registerAccount`, account map, re-register on respawn |
| `core/bootloader/src/automerge-protocol-handler.ts` (modify) | accounts, manifest requests, LRU, answers via `postIndexAnswer` |
| `core/bootloader/src/service-worker.ts` (modify) | `/@/` routing, `POST /@/.index`, legacy caching moved in, content caches survive `clearOtherCaches` |
| `core/patchwork/src/index.ts` (modify) | call `registerAccount(accountDocHandle.url)` |
| `sites/bench/tests/content-hash.spec.ts` (create) | hashing cost on a hit |
| `packages/e2e/tests/content-store.spec.ts` (create) | forged store entry and forged answer |

---

### Task 1: Walk carry-overs and `WalkOptions.find`

**Files:** Modify `core/filesystem/src/walk.ts`, `core/filesystem/src/providers.ts`. Test `core/filesystem/test/walk.test.ts`, `core/filesystem/test/providers.test.ts`.

**Interfaces:**
- Produces: `WalkOptions.find?: (url: AutomergeUrl, heads?: UrlHeads) => Promise<DocHandle<unknown>>`. It returns a handle that `enter` then `.view()`s at `heads ?? link heads ?? current`. The default is `repo.find` of the bare documentId url, as `enter` does now. `idhash` results are memoized in a module-level `Map<string, Promise<string>>`, cleared when it passes 10_000 entries.

- [ ] **Step 1: Write the failing tests**

```ts
it("walks through the find it's given", async () => {
  const { repo, a, accounts } = await fixture();
  const seen: string[] = [];
  const find = (url: AutomergeUrl) => (seen.push(url), repo.find(url));
  await resolveLivePath(repo, livePath(a, ["Projects", "foo"]), { accounts, find });
  expect(seen.length).toBeGreaterThanOrEqual(4); // account, /, Projects, foo
});
it("fails, not throws, when find rejects", ...)
  // find = () => Promise.reject(new Error("offline")) → resolveLivePath → undefined
```

```ts
it("warns about a malformed mount once, however often it's read", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const doc = account({ namespace: { "/x@y": [{ url: R }], "/": [{ url: R }] } });
  for (let i = 0; i < 5; i++) accountProvider.lookup(doc, ["a"]);
  expect(warn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/walk.test.ts test/providers.test.ts`
Expected: FAIL. `find` is never called (seen is empty), and warn is called 5 times.

- [ ] **Step 3: Implement**

- `accountBindings`: memoize in a `WeakMap<object, Map<…>>` keyed by the doc object.
- Warn once per malformed mount key, using a module-level `Set<string>`.
- `enter` calls `(options.find ?? defaultFind)(bareUrl, heads)` inside its existing `try`.

- [ ] **Step 4: Run them to see them pass, plus the whole filesystem suite**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem test`
Expected: PASS.

- [ ] **Step 5: Commit** `filesystem: walk takes a find, and remembers idhashes and warnings`

---

### Task 2: `readPath` and `listFiles`

**Files:** Modify `core/filesystem/src/walk.ts`, and `core/filesystem/src/resolve.ts` (export `materialize`). Test `core/filesystem/test/files.test.ts`.

**Interfaces:**
- Consumes: `walkPath`, `WalkEnd`, `providerFor`, `Child` (phase 1); `materialize(repo, node, typeHint?, walk?)` from `resolve.ts`.
- Produces:
  ```ts
  export type FileContent = { content: string | Uint8Array; type: string };
  /** What a path names, read: its pinned form, whether the input was canonical, and the bytes. */
  export function readPath(repo: Repo, path: string, options: WalkOptions):
    Promise<(FileContent & { pinned: string; canonical: boolean }) | undefined>;
  export type ListedFile = FileContent & { tail: string; documentId: DocumentId };
  /**
   * Every file under the last document a canonical pinned path enters, keyed by tail: "" for the
   * document itself, encoded names joined with "/" below it. Containers aren't listed; they have
   * their own doc steps. Undefined unless `path` is canonical and ends at a document.
   */
  export function listFiles(repo: Repo, path: string, options: WalkOptions):
    Promise<{ prefix: string; files: AsyncIterable<ListedFile> } | undefined>;
  ```
- `documentId` is the document holding the bytes: the leaf doc for a link, the enclosing doc for a value.

`listFiles` enumeration (the walk doesn't determine this):

```
emit("", end.handle.doc(), end.handle.documentId)
visit(node, names, docId) for each child of provider.list(node):
  value child, object (not bytes, not ImmutableString) → visit(value, [...names, ...name.split("/")], docId)
  value child, otherwise → emit(join(names + name parts), value, docId)
  link child → doc = find(link) at link heads or current; providerFor(doc) ? skip : emit(tail, doc, doc's id)
  union child → skip
tail = parts.map(encodeURIComponent).join("/")
If two entries produce the same tail, the one whose directory key had more "/"-separated parts wins, matching the walk's longest-prefix lookup.
```

- [ ] **Step 1: Write the failing tests**

```ts
it("reads a file and its pinned form", ...)
  // readPath(repo, livePath(a, ["packages","foo","dist","index.js"])) →
  //   content "mine", type "text/plain", canonical false, pinned === pinnedPath(...)
it("lists a directory package's files", ...)
  // tails sorted → ["", "dist/index.js", "package.json"]; each documentId is the file doc's
it("lists a folder's leaves and skips its subfolders", ...)
  // Projects/foo has notes (file) and sub (folder) → tails ["", "notes"]
it("lists nested values inside a directory doc", ...)
  // d.dist = { "a.js": "x" } with mimeType hint absent → tail "dist/a.js"
it("encodes names in tails", ...)  // key "my file@1.js" → tail "my%20file%401.js"
it("agrees with readPath for every file it lists", async () => {
  // for the directory package and the folder: for each listed file f,
  // readPath(prefix + (f.tail ? "/" + f.tail : "")) has the same content and type
});
it("lists nothing for a path that isn't canonical", ...)  // live path → undefined
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/files.test.ts`
Expected: FAIL, no export `readPath`.

- [ ] **Step 3: Implement both in `walk.ts`, exported from `index.ts` through the existing `export *`**

- [ ] **Step 4: Run the filesystem suite**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem test`
Expected: PASS.

- [ ] **Step 5: Commit** `filesystem: readPath and listFiles`

---

### Task 3: Store, index, and the request flow (bootloader, pure)

**Files:**
- Create `core/bootloader/vitest.config.ts` and `core/bootloader/test/setup.ts`, copied from `core/filesystem`.
- Add `"test": "vitest run"` to `core/bootloader/package.json`.
- Create `src/content-hash.ts`, `src/content-store.ts` and `src/pinned.ts`; modify `src/types.ts`.
- Test `core/bootloader/test/pinned.test.ts` and `test/content-store.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type IndexEntry = { sha256: string; contentType: string; store: boolean };
  export type Manifest = { prefix: string; entries: Record<string, IndexEntry> };

  // content-hash.ts
  export function toBytes(content: string | Uint8Array): Uint8Array; // strings → UTF-8
  export function contentHash(bytes: Uint8Array): Promise<string>;    // SHA-256, base64url, no padding

  // content-store.ts
  export interface ContentStore {
    get(hash: string): Promise<Uint8Array | undefined>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
    delete(hash: string): Promise<void>;
  }
  export const contentCacheName = (acctHash: string) => `patchwork-content-${acctHash}`;
  export const CONTENT_CACHE_PREFIX = "patchwork-content-";
  export function cacheStore(cache: Cache, origin: string): ContentStore; // key `${origin}/.content/${hash}`
  export function clearAccountStore(acctHash: string): Promise<boolean>;  // caches.delete

  // pinned.ts
  /** The `/@/` path, normalized so every spelling of one file is one key. */
  export function normalizePinned(path: string):
    { key: string; prefix: string; tail: string; acctHash?: string; pinned: boolean } | undefined;
  export function indexManifest(index: Map<string, IndexEntry>, manifest: Manifest): void;
  export class PinnedAbort extends Error {}
  export type PinnedDeps = {
    index: Map<string, IndexEntry>;
    store: ContentStore | undefined;         // undefined: nothing is read or written (share roots)
    hash(bytes: Uint8Array): Promise<string>;
    manifest(key: string): Promise<Manifest | undefined>;   // deduped by the caller, see below
    resolve(key: string): Promise<{ body: Uint8Array; contentType: string } | undefined>;
    warn(message: string): void;
    keep(work: Promise<unknown>): void;      // fetchEvent.waitUntil
  };
  export function servePinned(key: string, deps: PinnedDeps): Promise<Response>; // throws PinnedAbort
  /** Wrap a manifest fetcher so concurrent calls for one prefix share a request. */
  export function sharedManifests(fetch: (key: string) => Promise<Manifest | undefined>, prefixOf: (key: string) => string):
    (key: string) => Promise<Manifest | undefined>;
  ```

`normalizePinned` rules:
- Split on `/`, dropping empty segments.
- The root is pinned if it has a literal `@` or decodes to `automerge:`. A share root is written `automerge:` with the colon decoded.
- `prefix` runs up to and including the last segment that matches `/^[1-9A-HJ-NP-Za-km-z]+@[1-9A-HJ-NP-Za-km-z.]+$/`.
- In the prefix, plain names are re-encoded (`encodeURIComponent(decodeURIComponent(s))`) and doc steps are kept verbatim.
- Every tail segment is decoded and re-encoded the same way.
- `key = prefix + (tail ? "/" + tail : "")`.
- Undefined on a malformed escape.

`servePinned` follows spec section 5's *Request flow* exactly. The response headers are `content-type: entry.contentType` and `cache-control: public, max-age=31536000, immutable`. Without an index entry it's `no-store`.

- [ ] **Step 1: Write the failing tests** (fake store: a `Map`, real `contentHash`)

```ts
describe("normalizePinned", () => {
  it("gives one key for every spelling of a file", () => {
    const keys = ["acct@h/x@h/a@b.js", "acct@h/x@h/a%40b.js", "/acct@h//x@h/a%40b.js/"]
      .map((p) => normalizePinned(p)!.key);
    expect(new Set(keys).size).toBe(1);
    expect(normalizePinned("acct@h/x@h/日本")!.key).toBe(normalizePinned("acct@h/x@h/%E6%97%A5%E6%9C%AC")!.key);
  });
  it("splits at the last doc step", () => {
    expect(normalizePinned("acct@h/packages/m@h/f@h/dist/index.js")).toMatchObject({
      prefix: "acct@h/packages/m@h/f@h", tail: "dist/index.js", acctHash: "acct", pinned: true,
    });
  });
  it("says a live path is live", () => expect(normalizePinned("acct/Projects")!.pinned).toBe(false));
  it("reads a share root", ...)  // "automerge%3A<id>@h/x" → prefix starts "automerge:", acctHash undefined
});

describe("servePinned", () => {
  it("serves a store hit whose bytes match, without asking a resolver", ...)
  it("deletes a forged store entry, warns, and serves the resolver's real bytes", ...)
    // store.put(realHash, forged); index has realHash → body === real; warn called; store now holds real
  it("asks for one manifest on an index miss, then serves", ...)
  it("stores resolver bytes that match an entry that allows it", ...)
  it("never stores when the entry says not to", ...)
  it("fails as a network error when resolver bytes don't match, storing nothing", ...)
    // rejects with PinnedAbort; store empty
  it("serves inline and stores nothing with no manifest", ...)
    // manifest → undefined; resolve → bytes; response cache-control no-store; store empty; index empty
  it("rebuilds the index after a restart and re-uses the store", ...)
    // second deps with empty index, same store: one manifest, zero resolves, same bytes
  it("shares one manifest among concurrent requests for a package", ...)
    // sharedManifests: 5 parallel servePinned for 5 files of one prefix → fetch called once
});

describe("cacheStore", () => {
  it("round-trips bytes under /.content/<hash>", ...)  // fake Cache with put/match/delete over a Map keyed by url
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement the three modules and the types**

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: PASS.

- [ ] **Step 5: Commit** `bootloader: content store, index and the pinned request flow`

---

### Task 4: Manifests and the authenticated answer channel

**Files:** Create `core/bootloader/src/manifest.ts` and `core/bootloader/src/index-channel.ts`; modify `src/types.ts`. Test `test/manifest.test.ts` and `test/index-channel.test.ts`.

**Interfaces:**
- Consumes: `listFiles`, `WalkOptions` (Task 2); `contentHash`, `toBytes`, `Manifest` (Task 3).
- Produces:
  ```ts
  // types.ts
  export const AUTOMERGE_WORKER_PATH = "/automerge-protocol-handler-worker.js"; // setup.ts's default uses it
  export const INDEX_ANSWER_PATH = "/@/.index";
  export interface ManifestRequestMessage { type: "manifest"; id: string; path: string }
  export type IndexAnswer = { id: string; manifest?: Manifest; error?: string };
  export interface RegisterAccountMessage { type: "register-account"; url: AutomergeUrl }

  // manifest.ts
  export function buildManifest(repo: Repo, path: string, options: WalkOptions & {
    isProtected?: (documentId: DocumentId) => boolean; // default: !isUnprotectedDocId(documentIdToBinary(id))
  }): Promise<Manifest | undefined>;

  // index-channel.ts
  /** True only for the automerge worker: a sharedworker on this origin at AUTOMERGE_WORKER_PATH, any query. */
  export function isAutomergeWorker(client: Pick<Client, "type" | "url"> | undefined, origin: string): boolean;
  /** The service worker's side of POST /@/.index: 403 unless the client is the worker, else parse, hand the answer to onAnswer, and reply 204 with x-patchwork-index: accepted. */
  export function acceptIndexAnswer(request: Request, client: Pick<Client, "type" | "url"> | undefined,
    origin: string, onAnswer: (answer: IndexAnswer) => void): Promise<Response>;
  /** The worker's side: POST the answer, retrying (5 × 200ms) until a reply carries x-patchwork-index: accepted. */
  export function postIndexAnswer(answer: IndexAnswer, fetcher?: typeof fetch): Promise<boolean>;
  ```
- `buildManifest`:
  - Takes `listFiles(path)` and hashes `toBytes(content)` for each file.
  - Sets `store` per Decision 5. `prefixSegments[1]` is read from `parsePath(prefix).segments[0]`, which must be the name `packages`.
  - Returns `{ prefix, entries }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("buildManifest", () => {
  it("hashes each file as the service worker will", ...)
    // a file doc with content "héllo ✓" → entries["…"].sha256 === await contentHash(new TextEncoder().encode("héllo ✓"))
  it("stores unprotected content and, through /packages, protected content", ...)
    // isProtected: () => true → entries under a/Projects/... store false; under a/packages/... store true
  it("never stores under a share root", ...)
  it("returns nothing for a live path", ...)
});

describe("isAutomergeWorker", () => {
  const o = "https://p.test";
  it.each([
    [{ type: "sharedworker", url: `${o}/automerge-protocol-handler-worker.js` }, true],
    [{ type: "sharedworker", url: `${o}/automerge-protocol-handler-worker.js?x=1` }, true],
    [{ type: "worker", url: `${o}/automerge-protocol-handler-worker.js` }, false], // same url, dedicated
    [{ type: "window", url: `${o}/` }, false],
    [{ type: "sharedworker", url: `${o}/@/acct@h/evil.js` }, false],
    [{ type: "sharedworker", url: `https://evil.test/automerge-protocol-handler-worker.js` }, false],
    [undefined, false],
  ])("%j → %s", (client, ok) => expect(isAutomergeWorker(client as any, o)).toBe(ok));
});

describe("acceptIndexAnswer", () => {
  it("refuses a window with 403 and hands nothing on", ...)
  it("accepts the worker with 204 and the header", ...)
});

describe("postIndexAnswer", () => {
  it("retries a reply that skipped the service worker", async () => {
    const replies = [new Response("", { status: 404 }), new Response(null, { status: 204, headers: { "x-patchwork-index": "accepted" } })];
    const fetcher = vi.fn(async () => replies.shift()!);
    expect(await postIndexAnswer({ id: "1" }, fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("gives up after 5 tries", ...)
});
```

Bootloader tests that use a `Repo` need the wasm setup from Task 3's `test/setup.ts`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: PASS.

- [ ] **Step 5: Commit** `bootloader: manifests, and the worker's authenticated answers`

---

### Task 5: Resolvers answer paths and stop writing the cache

**Files:** Modify `core/bootloader/src/resolver.ts`, `src/types.ts` (`HandoffRequest.path?: string`) and `src/tab-resolver.ts`. Test `test/resolver.test.ts`.

**Interfaces:**
- Consumes: `readPath`, `pinnedPath`, `walkPath`, `WalkOptions` (filesystem); `toBytes`.
- Produces:
  - `HandoffRequest.path?: string`: the `/@/`-stripped path. For these requests the service worker sets `handoffURL` to `patchwork-path:` + path, so an old resolver parses it, sees a protocol that isn't `automerge:`, and declines.
  - `createResolver(getRepo, log?, accounts?: () => ReadonlyMap<string, AutomergeUrl>)`: the new third parameter defaults to an empty map.
  - `registerAccount(url: AutomergeUrl): Promise<string>` in `tab-resolver.ts` returns the acctHash. It adds the account to the map the tab's resolver reads. Task 6 makes it also post to the worker.
- `answer()`:
  - A `path` request that isn't pinned (`parsePath(path).root.heads` is missing), or isn't canonical:
    - 307 to `/@/` + `pinnedPath(...)`, with `cache-control: no-store`;
    - 404 if it doesn't resolve.
  - A canonical pinned `path`: inline `{ status: 200, headers: { "content-type": type }, body: toBytes(content) }`; 404 if it doesn't resolve.
  - An `automerge:` URL: as now, but always inline. The `cache-control` header is kept so the service worker can decide.
  - No `caches` calls remain in `resolver.ts`.
- The resolver's `find` for the walk:
  - With heads: `waitForHeads` (abort → `AbortHandoff`).
  - Without heads: `caughtUpWithPeers`.
  - Both use `AbortSignal.timeout(RESOLVE_TIMEOUT_MS)`.

- [ ] **Step 1: Write the failing tests** (node, in-memory `Repo`, no `caches` global: any call would throw)

```ts
it("redirects a live path to its pinned form", ...)
  // answer({ request: { path: livePath(a, ["Projects","foo","notes"]), handoffURL: "patchwork-path:…", … } })
  //   → type "response", status 307, headers.location === "/@/" + await pinnedPath(...), cache-control no-store
it("answers a pinned path with its bytes inline", ...)
  // status 200, content-type text/plain, body bytes === UTF-8 of "hi"
it("redirects a pinned-looking path that isn't canonical", ...)
it("answers an unknown path with 404", ...)
it("answers legacy automerge URLs inline, without touching caches", ...)
  // pinned automerge:<id>#heads/dist/index.js → type "response", cache-control includes immutable
it("registerAccount makes the tab's resolver answer for that account", ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: FAIL. Path requests return undefined, and the legacy test throws `caches is not defined`.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: PASS.

- [ ] **Step 5: Commit** `bootloader: resolvers answer /@/ paths and leave caching to the service worker`

---

### Task 6: The automerge worker builds and posts manifests; tabs register accounts

**Files:**
- Modify `core/bootloader/src/automerge-protocol-handler.ts`, `src/setup.ts`, `src/tab-resolver.ts`.
- Modify `core/patchwork/src/index.ts`.
- Test `core/bootloader/test/worker-manifests.test.ts`.

**Interfaces:**
- Consumes: `buildManifest`, `postIndexAnswer` (Task 4); `ManifestRequestMessage`, `RegisterAccountMessage`.
- Produces:
  - `createManifestHandler(getRepo, accounts, post = postIndexAnswer)` in `manifest.ts`. It returns `(message: ManifestRequestMessage) => Promise<void>`, and keeps an LRU of 64 manifests keyed by canonical prefix. Requests already in flight for the same `path` share one build. A failed build posts `{ id, error }`.
  - The worker wires it to `HANDOFF_CHANNEL` messages of `type: "manifest"`. It handles `register-account` port messages through `startWorkerControl`'s `onMessage`, adding `[await idhash(documentId), url]` to its accounts map. It counts manifest work in `handoffStarted`/`handoffFinished`, so a recycle waits for it.
  - `setup.ts`: `registerAccount` posts `{ type: "register-account", url }` to `automergeProtocolHandlerWorker`. It remembers the url and posts it again from the handle's `onSpawn`. Re-export `registerAccount` and `clearAccountStore` from `setup.ts`, the package's `.` entry.
  - `core/patchwork/src/index.ts`: after `resolveAccountHandle`, `await registerAccount(accountDocHandle.url)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("builds a manifest once per prefix and posts it", ...)
  // two messages for files of one package → post called twice with the same manifest, listFiles walked once (spy on find)
it("posts an error for a path it can't list", ...)
it("evicts the oldest manifest after 64", ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: FAIL, no `createManifestHandler`.

- [ ] **Step 3: Implement and wire, then typecheck the dependents**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem --filter @inkandswitch/patchwork-plugins --filter @inkandswitch/patchwork-bootloader build && pnpm --filter @inkandswitch/patchwork exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: PASS.

- [ ] **Step 5: Commit** `bootloader: the automerge worker answers manifests; tabs register their account`

---

### Task 7: The service worker serves `/@/`

**Files:** Modify `core/bootloader/src/service-worker.ts`. Test `core/bootloader/test/pinned.test.ts` (one case for the request builder) and a typecheck.

**Interfaces:**
- Consumes: everything from Tasks 3–5.
- Wiring, in order, in the `fetch` listener:
  1. `POST` to `INDEX_ANSWER_PATH`: `respondWith(acceptIndexAnswer(request, await clients.get(event.clientId), origin, settle))`. `settle` resolves the pending manifest request by `id`, and `indexManifest`s the answer.
  2. `GET` whose pathname starts with `/@/` and isn't `/@/.index`:
     - `normalizePinned(path)`; on undefined, 400.
     - Live → `handoff()` with `path`. The resolver's 307 is served as is (never cached).
     - Pinned → `servePinned(key, deps)`, with:
       - `store`: `cacheStore(await caches.open(contentCacheName(acctHash)), origin)`, or undefined for a share root;
       - `manifest`: `sharedManifests(requestManifest, prefixOf)`. `requestManifest` posts `{ type: "manifest", id, path: key }` on `HANDOFF_CHANNEL`, calls `startWorkerIfMissing`, and resolves on `settle` or after `MANIFEST_TIMEOUT_MS = 10_000` with undefined;
       - `resolve`: `handoff()` with `path: key`, read inline;
       - `keep`: `event.waitUntil`.
     - `PinnedAbort` → rethrow (a network error).
  3. Everything else, as today.
- `serveHandoff`, for legacy URLs: an inline `response` that is immutable (status 200/203/204, no `no-store` in `cache-control`) is `cacheInBackground` by its request URL. The `cached` branch stays for old workers.
- `clearOtherCaches` keeps every cache whose name starts with `CONTENT_CACHE_PREFIX`.
- Move the handoff-message construction into `pinned.ts` as `handoffRequest(request: Request, path?: string): HandoffRequestMessage` so it's testable.

- [ ] **Step 1: Write the failing test**

```ts
it("builds a path handoff that old resolvers decline", () => {
  const m = handoffRequest(new Request("https://p.test/@/acct/Projects"), "acct/Projects");
  expect(m.request.path).toBe("acct/Projects");
  expect(new URL(m.request.handoffURL).protocol).not.toBe("automerge:");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test`
Expected: FAIL, no export `handoffRequest`.

- [ ] **Step 3: Wire the service worker as above**

- [ ] **Step 4: Run the bootloader tests and typecheck**

Run: `pnpm --filter @inkandswitch/patchwork-bootloader test && pnpm --filter @inkandswitch/patchwork-bootloader exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit** `service worker: serve /@/ paths from the checked content store`

---

### Task 8: E2E and bench (CI)

**Files:** Create `packages/e2e/tests/content-store.spec.ts` and `sites/bench/tests/content-hash.spec.ts`.

**Interfaces:** The page exposes `window.patchwork.repo` and `window.patchwork.account`, as the existing e2e helpers use them. The acctHash is base58 of the first 12 bytes of SHA-256 over the account's `documentId`; the test computes it in the page with `crypto.subtle` and a short base58 loop.

- [ ] **Step 1: Write the e2e spec** (two tests)

```ts
test("a forged store entry is never served", async ({ page }) => {
  // boot; create a file doc "forge.js" (content "export default 42", mimeType text/javascript)
  // in the account's root folder; pinned = (await fetch(`/@/${acct}/forge.js`, { redirect: "manual" }) …)
  //   follow the 307 to get the pinned URL; fetch it once (stores it)
  // in the page: cache.put(`/.content/${sha256(real)}`, new Response("export default 666"))
  //   into caches.open(`patchwork-content-${acct}`)
  // reload; expect((await import(pinned)).default).toBe(42)
});
test("an index answer from a page is refused", async ({ page }) => {
  // fetch("/@/.index", { method: "POST", body: JSON.stringify({ id: "x", manifest: {...} }) }) → status 403
});
```

- [ ] **Step 2: Write the bench** `content-hash.spec.ts`: in `patchwork` mode, time `crypto.subtle.digest("SHA-256", …)` over 10 KB, 100 KB and 1 MB, 200 runs each. `record({ metric: "sha256 <size>", mode: "patchwork", value: median, unit: "ms" })`.

- [ ] **Step 3: Typecheck both**

Run: `pnpm --filter @inkandswitch/patchwork-e2e exec tsc --noEmit && pnpm --filter patchwork-bench exec tsc --noEmit`
Expected: no errors. Don't run them locally. CI's e2e matrix runs the spec on the PR.

- [ ] **Step 4: Commit** `e2e: forged store entries and forged answers; bench: hashing a hit`

---

### Task 9: Spec corrections and the changeset

**Files:** Modify `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`. Create `.changeset/paths-content-store.md`.

- [ ] **Step 1: Correct the spec**

- Section 5, *The index channel is authenticated*: "the automerge worker's script URL is fixed (`/automerge-protocol-handler-worker.js`), not hashed. A site that sets `workerPath` gets inline, unstored serving."
- *Remaining gaps*: add the cold-start cost from Decision 10, and say that Task 8's bench measures it.

- [ ] **Step 2: Write the changeset**

```markdown
---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

The service worker serves `/@/` paths. A live path (`/@/<acctHash>/Projects/foo/x.js`) redirects to its pinned form; a pinned one is served from a content-addressed store (`patchwork-content-<acctHash>`) whose every read is hashed and checked against an index that only the automerge worker fills, over `fetch()` requests the service worker checks are really from it. Resolvers no longer write the cache: they hand bytes back and the service worker decides what to keep, so legacy `/automerge%3A…` URLs are now cached by the service worker. New: `registerAccount` and `clearAccountStore` from `@inkandswitch/patchwork-bootloader`; `readPath`, `listFiles` and `WalkOptions.find` from `@inkandswitch/patchwork-filesystem`. The e2e suite gains a forged-store-entry test.
```

- [ ] **Step 3: Commit** `spec and changeset: content store`
