# Paths phase 1: grammar, providers, namespace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@inkandswitch/patchwork-filesystem` the path grammar, the built-in path providers, the account namespace, and the helpers that walk live and pinned paths. Nothing calls them yet except `resolvePath`, which moves onto the providers.

**Architecture:** Three new modules in `core/filesystem/src`: `paths.ts` (pure string grammar, no repo), `providers.ts` (sync, one doc or node at a time: "which child does this name pick?"), and `walk.ts` (async, follows links through a `Repo`, emits the pinned form as it goes). `resolve.ts` keeps its public `resolvePath` but dispatches through `providers.ts` instead of `FolderStrategy`.

**Tech Stack:** TypeScript, `@automerge/automerge-repo` (catalog pin 2.6.0-subduction.48), vitest in node, `bs58@^6.0.0`, `crypto.subtle`.

**Spec:** `docs/superpowers/specs/2026-10-28-paths-namespace-content-cache-design.md`. This plan covers **Implementation phases → 1**, plus the section 3 filesystem helpers (`idhash`, `livePath`, `parsePath`, `resolveLivePath`, `pinPath`), because they are pure filesystem code and phases 2–4 all consume them. Phases 2–4 get their own plans. Phase 2 waits on the two spikes.

## Global Constraints

- idhash = first 12 bytes of SHA-256 over the UTF-8 of the `documentId`, base58 (bitcoin alphabet). Not a secret.
- heads segment = the doc's heads in base58, **sorted**, joined with `.`.
- Pinned first segment: `<acctHash>@<heads>` or `automerge:<documentId>@<heads>`. The `automerge:` prefix tells them apart.
- Doc step syntax `<base58>@<heads>`. A segment is a doc step only if it parses that way **and** a link reachable from the current node has that idhash; otherwise it is a name.
- Provider order, first match wins: account, directory, folder, branches. Built-in only; the interface is exported.
- Namespace: `namespace?: { [mountPoint: string]: Array<{ url: AutomergeUrl }> }` on the account doc. Mount points are `/` or a top-level `/<name>` with no `/` or `@` in `<name>`. A mount shadows a same-named entry in `/`'s folder. Lookup: first binding with the name wins. Listing: concatenation.
- No `namespace` → `/` is `[{ url: rootFolderUrl }]`.
- Path segments are `encodeURIComponent`-encoded and slashes stay literal (same encoding the router will use in phase 3).
- Service worker URLs live under `/@/`. `pinPath` returns `<origin>/@/<pinned path>`; the service worker starts serving it in phase 2.
- No behaviour change at runtime: `createDefaultAccount`, the bootloader resolver, `ModuleWatcher` and the router are untouched in this phase.
- One changeset for the whole phase: `@inkandswitch/patchwork-filesystem: patch`, `@inkandswitch/patchwork-plugins: patch`.

## Decisions this plan makes that the spec leaves open

1. **The tail after the last container stays as names.** A link followed *by name* to a doc that has no provider (a file doc, a markdown doc) is written as its name(s), not `<idhash>@<heads>`. This is what the spec's example `<fooHash>@h/dist/index.js` shows, and the only form under which relative imports (`./util.js`) inside a package resolve. The cost: a leaf file doc reached by a bare link can still change under a pinned path. Phase 2's manifest, memoized by `container@heads`, is what freezes leaves. Doc steps that consume no name (union members, a branches doc's default) are always written as doc steps.
2. **A branches doc's lookup falls through to `default`.** If the next name isn't a branch name, the branches provider follows `default` without consuming the name. Packages published as a branches doc then resolve as `/packages/foo/dist/index.js`, the way the bootloader resolves them today. A branch name wins over a same-named file.
3. **The `/` fallback also applies when `namespace` exists but has no `/` key.**
4. **Child gets a third variant, `union`**, for a mount's bindings. The spec's `{ name, link | value }` can't express an ordered union.
5. **`resolveLivePath` and `pinPath` take an options bag** `{ accounts }` mapping acctHash → account url. In phase 2 the automerge worker fills this map from what tabs register.
6. **`FolderStrategy` is removed.** Its signature referenced the private `Walk` type, so nothing outside the package could implement it. `PathProvider` replaces it.

## Review Focus

- **Names with reserved characters:** a folder entry called `a/b`, `x@y`, `50%`, `my notes`, or `日本` should round-trip through `livePath` → `parsePath` and resolve to that entry. Pinned in Task 1 and Task 3.
- **A name that looks like a doc step:** a folder entry literally named `<some base58>@<base58>` should resolve as a name when no reachable link has that idhash. Pinned in Task 3.
- **Malformed or partial namespaces:** keys `packages` (no slash), `/a/b`, `/x@y`, a binding without a valid url, an account with neither `namespace` nor `rootFolderUrl`. Bad entries should be skipped with a `console.warn`. Nothing should throw. Pinned in Task 2.
- **Pinned heads the repo doesn't have, or malformed heads:** `resolveLivePath` should return `undefined`, not throw. Pinned in Task 3.
- **Cycles through steps that consume no name:** a branches doc whose `default` is itself, or a `/` binding that is the account doc itself. The walk should stop and return `undefined`. Pinned in Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `core/filesystem/src/paths.ts` (create) | `idhash`, heads segment, live/pinned path parse and format. No `Repo`. |
| `core/filesystem/src/providers.ts` (create) | `Child`, `PathProvider`, the four providers, `providerFor`, `accountBindings`, `asLink` (moved from `resolve.ts`). |
| `core/filesystem/src/walk.ts` (create) | `walkPath`, `resolveLivePath`, `pinnedPath`, `pinPath`, `listChildren`. |
| `core/filesystem/src/resolve.ts` (modify) | `resolvePath` dispatches through `providerFor`; `FolderStrategy` deleted. |
| `core/filesystem/src/types.ts` (modify) | `NamespaceBinding`, `Namespace`, `AccountNamespaceDoc`. |
| `core/filesystem/src/index.ts` (modify) | export the three new modules. |
| `core/filesystem/package.json` (modify) | add `"bs58": "^6.0.0"` to `dependencies`. |
| `core/plugins/src/account.ts` (modify) | `AccountDoc.namespace?: Namespace`. |
| `core/filesystem/test/paths.test.ts`, `providers.test.ts`, `walk.test.ts` (create) | unit tests, in-memory `new Repo()` as in `test/resolve.test.ts`. |
| `.changeset/paths-grammar-providers.md` (create) | the changeset. |

---

### Task 1: Path grammar

**Files:**
- Create: `core/filesystem/src/paths.ts`
- Modify: `core/filesystem/package.json` (add `bs58`), `core/filesystem/src/index.ts`
- Test: `core/filesystem/test/paths.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DocStep = { kind: "doc"; idhash: string; heads: UrlHeads; raw: string };
  export type NameStep = { kind: "name"; name: string };
  export type Segment = DocStep | NameStep;
  export type PathRoot =
    | { kind: "account"; acctHash: string; heads?: UrlHeads }
    | { kind: "share"; documentId: DocumentId; heads: UrlHeads };
  export type ParsedPath = { root: PathRoot; segments: Segment[] };
  export class PathSyntaxError extends Error {}

  export function idhash(documentId: string): Promise<string>;
  export function formatHeads(heads: readonly string[]): string;   // sorted copy, "."-joined
  export function parseHeads(segment: string): UrlHeads | undefined; // undefined unless every part is base58 and non-empty
  export function docStep(idhash: string, heads: readonly string[]): string; // `${idhash}@${formatHeads(heads)}`
  export function livePath(acctHash: string, names: string[]): string;
  export function parsePath(path: string): ParsedPath;               // throws PathSyntaxError
  ```
- `raw` on `DocStep` is the undecoded segment, so the walker can fall back to treating it as a name (`decodeURIComponent(raw)`).

- [ ] **Step 1: Write the failing tests**

```ts
describe("idhash", () => {
  it("is base58 of the first 12 bytes of sha-256 over the document id", async () => {
    expect(await idhash("2j9knpCseyhnK8izDmLpGP5WMdZQ")).toBe("vjRneszhMkDwr5tb");
  });
});

describe("heads", () => {
  it("sorts so one set of heads is one string", () => {
    expect(formatHeads(["c", "a", "b"])).toBe("a.b.c");
    expect(formatHeads(["b", "a"])).toBe(formatHeads(["a", "b"]));
  });
  it("parses only base58 parts", () => {
    expect(parseHeads("a.b")).toEqual(["a", "b"]);
    expect(parseHeads("a.0")).toBeUndefined();   // 0 isn't base58
    expect(parseHeads("a..b")).toBeUndefined();
    expect(parseHeads("")).toBeUndefined();
  });
});

describe("parsePath", () => {
  it("round-trips a live path, encoding each name", () => {
    const names = ["Projects", "a/b", "x@y", "50%", "my notes", "日本"];
    const path = livePath("acct", names);
    expect(path.split("/")).toHaveLength(1 + names.length); // a slash inside a name is encoded
    expect(parsePath(path)).toEqual({
      root: { kind: "account", acctHash: "acct" },
      segments: names.map((name) => ({ kind: "name", name })),
    });
  });
  it("reads a pinned path's doc steps and plain names", () => {
    const p = parsePath("acct@h2.h1/packages/mine@h3/foo@h4/dist/index.js");
    expect(p.root).toEqual({ kind: "account", acctHash: "acct", heads: ["h1", "h2"] });
    expect(p.segments.map((s) => s.kind)).toEqual(["name", "doc", "doc", "name", "name"]);
    expect(p.segments[1]).toEqual({ kind: "doc", idhash: "mine", heads: ["h3"], raw: "mine@h3" });
  });
  it("reads a share root", () => {
    expect(parsePath("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ@h1/x").root).toEqual({
      kind: "share", documentId: "2j9knpCseyhnK8izDmLpGP5WMdZQ", heads: ["h1"],
    });
    // the router and service worker hand over encoded segments
    expect(parsePath("automerge%3A2j9knpCseyhnK8izDmLpGP5WMdZQ@h1").root.kind).toBe("share");
  });
  it("treats an encoded @ as part of a name", () => {
    expect(parsePath("acct/a%40b").segments).toEqual([{ kind: "name", name: "a@b" }]);
  });
  it("ignores a leading slash and empty segments", () => {
    expect(parsePath("/acct//a/").segments).toEqual([{ kind: "name", name: "a" }]);
  });
  it("rejects a share root without heads, an empty path, and a bad root", () => {
    expect(() => parsePath("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ")).toThrow(PathSyntaxError);
    expect(() => parsePath("")).toThrow(PathSyntaxError);
    expect(() => parsePath("acct@0")).toThrow(PathSyntaxError);
    expect(() => parsePath("automerge:not-an-id@h1")).toThrow(PathSyntaxError);
  });
});
```

(`h1`…`h4`, `acct`, `mine`, `foo` are all valid base58. Keep test fixtures base58.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/paths.test.ts`
Expected: FAIL, cannot resolve `../src/paths.js`.

- [ ] **Step 3: Add `"bs58": "^6.0.0"` to `dependencies` and run `pnpm install`, then implement `paths.ts`**

- Base58: `/^[1-9A-HJ-NP-Za-km-z]+$/`.
- `idhash`: `crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))`, take `.slice(0, 12)`, `bs58.encode`.
- Root segment: if `decodeURIComponent(raw)` starts with `automerge:`, it's a share root. Split on the **last** `@`, check the id with `isValidDocumentId`, and require heads. Otherwise `<base58>` or `<base58>@<heads>`; anything else throws.
- Other segments: a raw segment containing a literal `@` whose two halves are base58 and `parseHeads` is a `DocStep`. Everything else becomes `{ kind: "name", name: decodeURIComponent(raw) }`.
- Export it from `index.ts`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/filesystem/package.json pnpm-lock.yaml core/filesystem/src/paths.ts core/filesystem/src/index.ts core/filesystem/test/paths.test.ts
git commit -m "filesystem: path grammar (idhash, heads, live and pinned paths)"
```

---

### Task 2: Providers and the account namespace

**Files:**
- Create: `core/filesystem/src/providers.ts`
- Modify: `core/filesystem/src/types.ts`, `core/filesystem/src/index.ts`, `core/plugins/src/account.ts`, `core/filesystem/src/resolve.ts` (only to import `asLink` from `providers.ts` instead of defining it)
- Test: `core/filesystem/test/providers.test.ts`

**Interfaces:**
- Consumes: `getType`, `getDefaultBranch`, `BranchesDoc`, `FolderDoc` (existing).
- Produces:
  ```ts
  // types.ts
  export type NamespaceBinding = { url: AutomergeUrl };
  export type Namespace = { [mountPoint: string]: NamespaceBinding[] };
  export type AccountNamespaceDoc = HasPatchworkMetadata<"account"> & {
    namespace?: Namespace;
    rootFolderUrl?: AutomergeUrl;
  };

  // providers.ts
  export type Child =
    | { name: string; link: AutomergeUrl }
    | { name: string; value: unknown }
    | { name: string; union: AutomergeUrl[] };
  /** `consumed` is how many leading names the step used: 0 for a step that consumes none (the `/` mount, a branches doc's default). */
  export type Lookup = { child: Child; consumed: number };
  export interface PathProvider {
    readonly kind: string;
    matches(doc: unknown): boolean;
    lookup(node: unknown, names: string[]): Lookup | undefined; // names.length >= 1
    list(node: unknown): Child[];
  }
  export const accountProvider: PathProvider;    // kind "account"
  export const directoryProvider: PathProvider;  // kind "directory"
  export const folderProvider: PathProvider;     // kind "folder"
  export const branchesProvider: PathProvider;   // kind "branches"
  export const PROVIDERS: readonly PathProvider[]; // [account, directory, folder, branches]
  export function providerFor(doc: unknown): PathProvider | undefined;
  /** Mount point ("/" or "/name") → bindings, with "/" falling back to rootFolderUrl. Invalid keys and bindings are skipped with a warning. */
  export function accountBindings(doc: AccountNamespaceDoc): Map<string, AutomergeUrl[]>;
  export function asLink(value: unknown): AutomergeUrl | undefined; // moved verbatim from resolve.ts
  ```
- `AccountDoc` in plugins gains `namespace?: Namespace` (imported as a type from `@inkandswitch/patchwork-filesystem`).

Provider behaviour:
- **account**: `lookup` returns the union of `/<names[0]>` with `consumed: 1` if that mount exists (and isn't `/`). Otherwise it returns `{ child: { name: "", union: bindings("/") }, consumed: 0 }`, or `undefined` if `/` has no bindings. `list` returns a union child per mount: `name` is the mount without its slash, and `/` is `""`.
- **directory**: on the node it's given (the doc or an object nested in it), the longest prefix of `names` joined with `/` that is a key. A link value gives `{ link }`, anything else `{ value }`. `consumed` = prefix length. `list` returns every key except `@patchwork`.
- **folder**: first `.docs` entry whose `String(name) === names[0]` with a valid link, `consumed: 1`. `list` returns each entry with a valid link.
- **branches**: `names[0]` names a branch → that link, `consumed: 1`. Otherwise `default`, `consumed: 0`; `undefined` if there is no default (`getDefaultBranch` throws, so catch it). `list` returns each branch.

- [ ] **Step 1: Write the failing tests**

All tests use plain objects. Providers are synchronous and never touch a repo. Use real automerge urls from `generateAutomergeUrl()`.

```ts
describe("accountProvider", () => {
  it("looks a mount up by name and consumes it", ...)
    // namespace { "/": [{url: R}], "/packages": [{url: P1}, {url: P2}] }
    // lookup(doc, ["packages", "foo"]) → { child: { name: "packages", union: [P1, P2] }, consumed: 1 }
  it("sends any other name to / without consuming it", ...)
    // lookup(doc, ["Projects"]) → { child: { name: "", union: [R] }, consumed: 0 }
  it("falls back to rootFolderUrl with no namespace, or no / key", ...)
    // { rootFolderUrl: R } and { rootFolderUrl: R, namespace: { "/packages": [...] } } both → "/" union [R]
  it("finds nothing with neither namespace nor rootFolderUrl", ...)
    // lookup(doc, ["x"]) → undefined; list(doc) → []
  it("skips malformed mounts and bindings with a warning", ...)
    // keys "packages", "/a/b", "/x@y" and a binding { url: "nope" } are absent from accountBindings;
    // console.warn spied, called; no throw
  it("lists every mount as a union child", ...)
    // list → [{ name: "", union: [R] }, { name: "packages", union: [P1, P2] }] (order: "/" first, then object order)
});

describe("directoryProvider", () => {
  it("matches the longest prefix", ...)
    // { "dist": {..}, "dist/index.js": L } lookup ["dist","index.js"] → { child: { name: "dist/index.js", link: L }, consumed: 2 }
  it("returns a nested object as a value child", ...)
  it("reads ImmutableString links", ...)
  it("does not list @patchwork", ...)
});

describe("folderProvider", () => {
  it("first entry with the name wins", ...)
    // docs [{name:"a", url: A1}, {name:"a", url: A2}] → link A1
  it("misses an unknown name", ...)
});

describe("branchesProvider", () => {
  it("follows a named branch", ...)          // consumed 1
  it("falls through to default for any other name", ...) // consumed 0, link = default
  it("finds nothing with no default branch", ...)        // undefined, no throw
});

describe("providerFor", () => {
  it("checks account, directory, folder, branches in order", ...)
    // an object with @patchwork.type "account" and a docs array → accountProvider
    // a directory-typed doc with docs: [] → directoryProvider
    // a file doc → undefined
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/providers.test.ts`
Expected: FAIL, cannot resolve `../src/providers.js`.

- [ ] **Step 3: Implement `providers.ts`, the namespace types, and `AccountDoc.namespace`**

Mount key regex: `/^\/[^/@]*$/`. `accountBindings` builds the map from `namespace`, then sets `/` from `rootFolderUrl` if `/` is absent. `account` matches on `getType(doc) === "account"`.

- [ ] **Step 4: Run them to see them pass, along with the existing resolve tests**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/providers.test.ts test/resolve.test.ts test/resolve-pinning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/filesystem/src/providers.ts core/filesystem/src/types.ts core/filesystem/src/index.ts core/filesystem/src/resolve.ts core/plugins/src/account.ts core/filesystem/test/providers.test.ts
git commit -m "filesystem: path providers and the account namespace"
```

---

### Task 3: Walking live and pinned paths

**Files:**
- Create: `core/filesystem/src/walk.ts`
- Modify: `core/filesystem/src/index.ts`
- Test: `core/filesystem/test/walk.test.ts`

**Interfaces:**
- Consumes: Task 1's `parsePath`, `idhash`, `docStep`, `formatHeads`, `ParsedPath`. Task 2's `providerFor`, `PathProvider`, `Child`, `accountBindings`. `documentBaseOrigin` from `urls.ts`.
- Produces:
  ```ts
  export type WalkOptions = {
    /** acctHash → account doc url. The roots a live or pinned account path may start at. */
    accounts: ReadonlyMap<string, AutomergeUrl>;
  };
  export type WalkEnd = {
    /** The last document the walk entered, as a view at the heads it was read at. */
    handle: DocHandle<unknown>;
    /** Where the walk stopped inside it: handle.doc(), or a value nested in it. */
    node: unknown;
    /** The pinned path, without a leading slash. */
    pinned: string;
  };
  export function walkPath(repo: Repo, path: string, options: WalkOptions): Promise<WalkEnd | undefined>;
  /** The document a live or pinned path names. undefined if it doesn't resolve or ends at a value inside a doc. */
  export function resolveLivePath(repo: Repo, path: string, options: WalkOptions): Promise<DocHandle<unknown> | undefined>;
  export function pinnedPath(repo: Repo, path: string, options: WalkOptions): Promise<string | undefined>;
  /** `${documentBaseOrigin()}/@/${pinnedPath}` */
  export function pinPath(repo: Repo, path: string, options: WalkOptions): Promise<string | undefined>;
  /** The children of a doc, with unions expanded: an account's `/` listing concatenated and shadowed by its mounts; any other doc's provider list. */
  export function listChildren(repo: Repo, handle: DocHandle<unknown>): Promise<Child[]>;
  /** Every binding's children, concatenated in binding order. Phase 4 lists `/packages` with this. */
  export function listUnion(repo: Repo, urls: AutomergeUrl[]): Promise<Child[]>;
  ```
- `resolveLivePath` returns the live handle (`repo.find(url)`) when the input was a live path, and the view when it was pinned. To decide, check whether the parsed root has heads.

Walk algorithm. The signatures don't determine this:

```
root:
  account → url = accounts.get(acctHash) ?? fail; handle = find(url); heads = root.heads ?? handle.heads()
            view = handle.view(heads); emit docStep(acctHash, heads)
  share   → handle = find(documentId).view(heads); emit `automerge:${documentId}@${formatHeads(heads)}`
state: { handle, node = handle.doc(), provider = providerFor(node) }

loop while segments remain:
  if next is DocStep:
    for each link reachable from node (provider.list(node): link children and every union member,
                                       plus the branches default):
      if await idhash(documentIdOf(link)) == step.idhash → enter(link, step.heads), emit step.raw, consume 1, continue loop
    otherwise fall through and treat it as NameStep(decodeURIComponent(step.raw))
  names = the run of leading name segments
  { child, consumed } = provider.lookup(node, names) ?? fail
  value child → node = value; emit names[0..consumed] encoded; stay with the same provider
  link child  → doc = find(link); if providerFor(doc): enter at current heads, emit docStep
                else (leaf): emit names[0..consumed] encoded; if segments remain after, fail; end here
  union child → emit names[0..consumed] encoded (none for "/");
                rest = names after consumed
                member = rest.length ? first member whose providerFor(doc).lookup(doc, rest) is defined
                                     : first member
                enter(member, current heads), emit docStep
at the end: if provider is branches and nothing remains → enter default, emit docStep
```

- "enter" = `find(url)`, a `view(heads)`, and `providerFor(doc)`. If `view` throws (heads the repo doesn't have), fail.
- "fail" returns `undefined`. The only thing that throws is `parsePath` on syntax.
- Cycle guard: keep a `Set` of `documentId|segmentsRemaining` for steps that consume nothing (union member, branches default). Revisiting one fails.
- `idhash` results are memoized per walk in a `Map`.

- [ ] **Step 1: Write the failing tests**

Fixture: build one in-memory account with `new Repo()`:
`account { @patchwork: account, namespace: { "/": [root], "/packages": [mine, team] } }`, where
- root is a folder `Projects`, and `Projects` is a folder containing `foo` (a folder holding `notes` → a file doc),
- mine is a folder with `foo` → a pushwork-shaped directory doc (`package.json`, `dist/index.js` file links),
- team is a folder with `foo` (a different package) and `bar`.

Set `accounts = new Map([[await idhash(account.documentId), account.url]])`.

```ts
it("resolves a live path through / and returns the live handle", ...)
  // resolveLivePath(repo, livePath(a, ["Projects","foo","notes"]), {accounts}) → handle.url === notes.url (no heads)
it("pins every container the walk enters, and keeps the tail after the last one as names", async () => {
  const pinned = await pinnedPath(repo, livePath(a, ["packages", "foo", "dist", "index.js"]), { accounts });
  expect(pinned).toBe(
    `${docStep(a, account.heads())}/packages/${docStep(await idhash(mine.documentId), mine.heads())}` +
    `/${docStep(await idhash(minePkg.documentId), minePkg.heads())}/dist/index.js`
  );
});
it("writes the / binding as a doc step with no name", ...)
  // pinnedPath(a/Projects/foo) === `${acct}/${root}/${projects}/${foo}` (doc steps only)
it("union: the first binding with the name wins", ...)
  // packages/foo → mine's foo; packages/bar → team's bar
it("a mount shadows a same-named entry in /'s folder", ...)
  // root folder also has an entry "packages"; a/packages/foo still goes through the mount
it("a pinned path keeps resolving to the same version after a rename", async () => {
  // pin a/Projects/foo/notes, then rename foo → bar and change notes' content
  // resolveLivePath(pinned) → the foo doc's view at its old heads (the same documentId as foo)
  // resolveLivePath(live a/Projects/foo/notes) → undefined; a/Projects/bar/notes → resolves
});
it("a pinned path that walks into a branches doc follows its default", ...)
  // packages entry "branchy" → a branches doc whose default is a directory doc; packages/branchy/dist/index.js resolves,
  // and the pinned form has a doc step for the branches doc and another for its default
it("resolves a name that looks like a doc step but matches no link", ...)
  // a folder entry named `${await idhash(someOtherId)}@h1`; the literal segment resolves to that entry
it("resolves a name with reserved characters", ...)
  // entry "a/b c@%" under Projects; resolveLivePath(livePath(a, ["Projects","a/b c@%"])) finds it
it("returns undefined for an unknown account, missing names, and heads the repo doesn't have", ...)
it("stops on a branches doc whose default is itself", ...)   // resolves undefined, doesn't hang
it("stops when / is bound to the account itself", ...)       // a/x → undefined
it("pinPath prefixes the origin and /@/", ...)               // stub globalThis.location for node
it("lists an account's children: mounts shadow / entries, unions concatenate", ...)
  // listChildren(repo, account) → names include "Projects" and "packages", each once
  // listUnion(repo, [mine.url, team.url]) → names ["foo", "foo", "bar"]: concatenated, not deduplicated
```

`listChildren` on an account keeps each mount as one `{ name, union }` entry. It replaces the `/` union with its members' children, minus any name a mount shadows.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/walk.test.ts`
Expected: FAIL, cannot resolve `../src/walk.js`.

- [ ] **Step 3: Implement `walk.ts` per the algorithm above, and export it from `index.ts`**

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/walk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/filesystem/src/walk.ts core/filesystem/src/index.ts core/filesystem/test/walk.test.ts
git commit -m "filesystem: resolve and pin live paths through the namespace"
```

---

### Task 4: `resolvePath` on providers

**Files:**
- Modify: `core/filesystem/src/resolve.ts`
- Test: `core/filesystem/test/resolve.test.ts` (add one case)

**Interfaces:**
- Consumes: `providerFor`, `Lookup`, `asLink` from Task 2.
- Produces: unchanged `resolvePath(repo, rootHandle, parts): Promise<Resolved | undefined>` and `Resolved`. `FolderStrategy` is deleted.

`resolvePath` keeps its contract: it serves bytes, follows bare links, and reports `pinned` honestly. It does not go through `walkPath`, which pins and doesn't materialize. Replace `STRATEGIES` with `providerFor(doc)`, and `walkDirectoryDoc`'s prefix loop with `provider.lookup(node, parts)`. A value child keeps walking in the same provider, a link child keeps `walk.pinned &&= hasHeads(link)` and the visited-set cycle check, and a union child (only an account doc yields one) follows its first member. `materialize` is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it("follows a branches doc's default branch", async () => {
  const repo = new Repo();
  const pkg = publish(repo, (url) => url);
  const branches = repo.create({ "@patchwork": { type: "branches" }, branches: { default: pkg.url } });
  const index = await resolvePath(repo, branches, ["dist", "index.js"]);
  expect(decode(index!.content)).toBe("export default 1");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem exec vitest run test/resolve.test.ts`
Expected: FAIL. `index` is undefined, because no strategy matches a branches doc.

- [ ] **Step 3: Rewrite the dispatch in `resolve.ts` as described**

- [ ] **Step 4: Run the whole filesystem suite**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem test`
Expected: PASS, including `resolve-pinning.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add core/filesystem/src/resolve.ts core/filesystem/test/resolve.test.ts
git commit -m "filesystem: resolvePath dispatches through path providers"
```

---

### Task 5: Typecheck downstream and add the changeset

**Files:**
- Create: `.changeset/paths-grammar-providers.md`

- [ ] **Step 1: Build the two touched packages and typecheck their dependents**

Run: `pnpm --filter @inkandswitch/patchwork-filesystem --filter @inkandswitch/patchwork-plugins build && pnpm --filter @inkandswitch/patchwork-bootloader --filter @inkandswitch/patchwork exec tsc --noEmit`
Expected: no errors. (Don't run e2e or site builds locally; CI does.)

- [ ] **Step 2: Write the changeset**

```markdown
---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-plugins": patch
---

Add paths: `idhash`, `livePath`, `parsePath`, `resolveLivePath`, `pinnedPath`, `pinPath` and `listChildren` walk an account's namespace by name and write the pinned `<idhash>@<heads>` form that imports and share links will use. Path providers (`accountProvider`, `directoryProvider`, `folderProvider`, `branchesProvider`, `PathProvider`) replace `FolderStrategy`, which is removed; `resolvePath` now also follows a branches doc to its default branch. `AccountDoc` gains an optional `namespace` mount table; without one, `/` is `rootFolderUrl`. Nothing calls the new path helpers yet.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/paths-grammar-providers.md
git commit -m "changeset: paths grammar and providers"
```
