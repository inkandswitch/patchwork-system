# Paths, namespace, and a content-addressed package cache

Status: design, approved in conversation 2026-10-28. Not implemented.

## Goals

- Clicking an item in the sidebar sets `&path=` in the hash to a readable path
  rooted at the account, and a tool can be opened at a path.
- Paths are real: the service worker serves them, packages are imported
  through them, and the filesystem is a namespace rather than only the
  `.docs` walk of the root folder.
- Package management is a folder: whatever is bound at `/packages`.
- URLs don't carry raw document ids unless a portable share link is wanted.
- The package cache can't be poisoned by a crafted link, by code running on
  the origin writing to CacheStorage, or by a stale name resolution.

## Non-goals

- Cache isolation between two accounts in the same browser profile.
- Running package code on a separate origin. This design is meant not to
  preclude it (the store and index work the same there), but doesn't do it.
- Mount points below the top level of the namespace.
- Path providers supplied by packages.
- Garbage collection of the content store.

## Threat model

| Attacker | In scope | What stops it |
|---|---|---|
| A crafted link makes the service worker cache content under a key your own imports later hit | yes | Only pinned URLs are stored, and the index maps a pinned URL to the hash of what is really at those heads |
| Code on the origin (a package or tool) writes to CacheStorage | yes | Every store read is hashed and compared; the index lives only in service worker memory and is filled only by the automerge worker over an authenticated channel |
| A name path resolved once keeps serving old content | yes | Names are never stored; only pinned URLs are, and they can't change meaning |
| Another account on the same origin | no | — |

Everything on the origin shares one realm boundary, so this raises the bar
rather than closing it. What stays open is listed under
[Remaining gaps](#remaining-gaps).

## 1. Path grammar

### Identifiers

- **idhash** of a document: the first 12 bytes of SHA-256 over the UTF-8 of
  its `documentId`, in base58. It only distinguishes a doc from its siblings
  and keeps the id out of URLs. It is not a secret and not a security
  boundary.
- **acctHash**: the idhash of the account document.
- **heads**: the doc's heads in base58, sorted, joined with `.`. Sorting
  makes one set of heads one URL. Base58 has no `.`, so it's unambiguous.

### Live path

What the address bar holds and what people read. Names resolve at the
current heads of everything along the way.

```
&path=<acctHash>/Projects/foo/index.js
```

### Pinned path

What imports and share links use. Every document the walk enters is pinned:

1. A step that follows a link **by name** is written `<idhash>@<heads>` in
   place of the name.
2. A step that follows a link **without consuming a name** (a union member,
   a link that points at a link) adds its own `<idhash>@<heads>` segment.
3. A step **inside** a document (a directory key, a mount name in the
   account doc) stays a plain name, since the enclosing doc's heads already
   pin it.

```
live:    <acctHash>/Projects/foo/dist/index.js
pinned:  <acctHash>@h/<rootHash>@h/<projectsHash>@h/<fooHash>@h/dist/index.js

live:    <acctHash>/packages/foo/dist/index.js
pinned:  <acctHash>@h/packages/<myPackagesHash>@h/<fooHash>@h/dist/index.js
```

When resolving, a segment is a doc step if it parses as `<base58>@<heads>`
and a link reachable from the current node hashes to that idhash; otherwise
it's a name.

The first segment of a pinned path is either an acctHash the resolver knows
locally, or `automerge:<documentId>@<heads>` for a portable share link (safe
to hand out once the doc is on keyhive, since the id no longer grants
access). The `automerge:` prefix is what tells the two apart.

A pinned path never changes meaning, so whoever builds an import URL builds
the whole chain first. Nothing in a module graph goes through a redirect: the
ES module map keys an entry by the URL requested, so a redirect is memoized
for the life of the realm (the same reason `importModule` retries with
`?retry=1`).

## 2. Path providers and the namespace

### Providers

A provider matches a document and lists its children as
`{ name, link | value }`. Walking a path asks the current doc's provider for
the next child. This generalizes `FolderStrategy` in
`core/filesystem/src/resolve.ts`.

Built-in providers, checked in order, first match wins:

- **account**: a doc whose `@patchwork.type` is `account`; its children are
  the namespace (below).
- **directory**: keys, longest prefix first, as `walkDirectoryDoc` does now.
- **folder**: `.docs` by `name`.
- **branches**: each branch by name. A path that ends at a branches doc
  stands for its `default` branch. This replaces the special case in
  `core/bootloader/src/resolver.ts`.

Providers are built in only. The automerge worker runs them to build the
cache index, so a package-supplied provider would put package code inside
the resolver the index trusts. The provider interface is exported, shaped so
package providers can be added later.

### Namespace

The account doc gets an ordered mount table:

```ts
namespace?: {
  [mountPoint: string]: Array<{ url: AutomergeUrl }>;
};
// e.g.
// "/":         [{ url: rootFolderUrl }]
// "/packages": [{ url: myPackagesUrl }, { url: teamPackagesUrl }]
```

Union semantics, after plan9:

- Lookup tries each binding of a mount in order; the first that has the name
  wins.
- Listing concatenates every binding's children.
- Array position takes the place of `bind -b` / `bind -a`.
- A mount shadows an entry of the same name in `/`'s folder.
- Mount points are top-level names only, and may not contain `@`.
- Only automerge documents can be bound.

If `namespace` is missing, `/` falls back to `rootFolderUrl`, so older
accounts and older readers keep working.

The automerge worker needs to know acctHash → account url to resolve a path's
root. Tabs register it with the worker at boot.

## 3. Service worker URLs and routing

### URLs

All new forms live under a reserved prefix, so no site file can be mistaken
for a path:

```
/@/<live path>      e.g. /@/<acctHash>/Projects/foo/x.js
/@/<pinned path>    e.g. /@/<acctHash>@h/<rootHash>@h/.../x.js
```

- A **live** URL answers with a 307 to its pinned form, computed by a
  resolver. Fine for `fetch()`; never use one for `import()`.
- A **pinned** URL is served from the content store (section 5).
- Existing `/automerge%3A…/` URLs keep working as they do today, keyed by URL
  and unchecked. They are deprecated.

### Hash routing

- `path` joins `HASH_KEY_ORDER` in `core/patchwork/src/router.ts`. Each
  segment is `encodeURIComponent`-encoded and the slashes stay literal.
- `doc=` says what is open; `path=` says where it was opened from.
- A hash with `path=` and no `doc=` resolves the path and opens the result.
- If `doc=` and `path=` disagree (something moved or was renamed), `doc=`
  wins and `path=` is dropped with a console warning.

### Opening at a path

Builds on the `open-document-path` branch (48f4ab98):

- `patchwork:open-document`'s `path` field holds the **live path** (it was a
  service-worker path on that branch), and the router writes it to `&path=`.
  This reverses that branch's choice to keep it out of the hash.
- `<patchwork-view path>` hands it to the tool without remounting, as on that
  branch.
- The sidebar (an installed tool, not in this repo) dispatches
  `{ url, path }` on click, using the names it walked.

### Helpers in `@inkandswitch/patchwork-filesystem`

- `idhash(documentId)`
- `livePath(acctHash, names)`
- `parsePath(path)`: live or pinned, into segments
- `resolveLivePath(repo, path)` → handle
- `pinPath(repo, path)` → pinned service-worker URL, for fetching siblings or
  importing

## 4. Packages via `/packages`

- Package management is whatever is bound at `/packages`. The folder can live
  anywhere in the tree, or nowhere.
- `ModuleWatcher` gets a third source kind, `folder` (alongside automerge
  module-settings docs and HTTP manifests), pointed at the `/packages` union:
  - The module list is the union listing, deduplicated by document id. Two
    packages with the same name both load; the name only decides which one a
    path lookup finds.
  - Packages are tracked by document id, so a rename doesn't reload anything.
  - When a package's own heads move, the watcher builds its pinned chain with
    `pinPath` and imports it. Other packages keep their existing URLs: a
    pinned URL stays valid forever, so a change elsewhere in the chain
    doesn't reload them.
  - `PackageTracker.findLatest` keeps asking the service worker, in the new
    grammar.
- The site's `system` HTTP manifest stays a separate source.
- A link under `/packages` that isn't a package (no `package.json`) is
  warned about and skipped.

### Accounts

- `createDefaultAccount` binds `/` to the root folder and `/packages` to a new
  folder.
- Migration, once at boot: if the account has `moduleSettingsUrl` and no
  `/packages` binding, create a folder, add a link for each automerge entry
  (named by `package.json` `name`, falling back to the doc title), and bind
  it at `/packages`. The module-settings doc is left untouched.
- Builds older than this one keep reading the frozen module-settings list, so
  packages installed afterwards won't show up there.
- `AccountDoc.moduleSettingsUrl` is deprecated in favour of the `/packages`
  binding.

## 5. Content store and index

### Store

- A CacheStorage cache named `patchwork-content-<acctHash>`, separate from
  the `patchwork` cache that holds site pages and assets.
- Key: `/.content/<sha256 base64url>`, an internal key that is never fetched.
- Value: the bytes only. The content type lives in the index, so identical
  bytes are stored once whatever their type.
- Reads and writes go through one small interface (`get(hash)`,
  `put(hash, bytes)`), so entries can later be encrypted under an at-rest key.
- `clearAccountStore(acctHash)` deletes the cache. There is no sign-out flow
  today; a site calls this from its own.

### What gets stored

- Content from unprotected documents (`isUnprotectedDocId`).
- Content from keyhive-protected documents only when reached through
  `/packages`. Package code needs to load fast at boot; user documents don't.
- Everything else is served inline: checked, never stored.

### Index

A `Map` in service worker memory: pinned URL → `{ sha256, contentType }`.

- Lost when the service worker is stopped, which is fine.
- On a miss, the service worker asks the automerge worker for the **manifest
  of the last document in the URL at its heads**: hash and type of every file
  that resolves pinned inside it. One round trip per package rather than per
  file.
- The automerge worker memoizes manifests by `doc@heads` in an LRU; they never
  change.

### Request flow for a pinned URL

1. **Index hit:** read the store, hash the bytes, compare.
   - Match: serve.
   - Mismatch: delete the entry, warn loudly, go to step 3.
2. **Index miss:** fetch the manifest, then step 1.
3. **Store miss:** ask a resolver for the bytes and hash them in the service
   worker.
   - Matches the index entry: serve, and store it if
     [What gets stored](#what-gets-stored) allows.
   - Doesn't match: fail as a network error, store nothing.
   - No index entry, because no automerge worker is available: serve inline,
     store nothing.

Hashing is `crypto.subtle` SHA-256 on every hit, since a store entry can
change between two reads. `sites/bench` gets a case measuring it.

### Who is trusted for what

- **Resolvers never write the cache.** Today `resolver.ts` calls `cache.put`
  itself. Instead a resolver returns bytes, and the service worker decides.
- **Only the automerge worker fills the index.** Tab resolvers run in the
  same realm as packages; their answers are served inline and never stored.
- **The index channel is authenticated.** Today's `HANDOFF_CHANNEL` is a
  BroadcastChannel: any context on the origin can listen, see request ids,
  and reply first with a forged response. That is a hole in the current code
  as well. Index answers must arrive from a `Client` whose `type` is
  `sharedworker` and whose `url` is the automerge worker's script URL, which
  the service worker knows at build time.
  - The worker sends answers as `fetch()` requests to a reserved path. The
    service worker looks up `event.clientId` with `clients.get` and checks
    the client. This is the only reply path that works in all three engines
    (see [Spikes](#spikes-before-planning)).
  - Requests can stay on a BroadcastChannel. A listener learns which pinned
    URLs are being loaded, which it could see anyway, but it can't answer.
  - Checking `type` is not optional. Any page can start a dedicated `Worker`
    from the same script URL, and it shows up with the same `url` and
    `type: "worker"`.

## Remaining gaps

These replace the deleted `package-load-gate.md` note.

- Offline, `servePassthrough` falls back to the URL-keyed `patchwork` cache,
  which any code on the origin can write. Site assets, the automerge worker's
  script included, come from there.
- Packages can write the automerge worker's IndexedDB/OPFS storage.
  Automerge verifies change hashes when it loads a document, so tampered
  changes don't load as the heads they claim. That check is planned to become
  optional; when it does, this gap reopens unless patchwork keeps it on.
- A live → pinned redirect answered by a tab can point at the wrong version.
  It can't poison the store, but it decides which version a tab loads.
- Legacy `/automerge%3A…` URLs stay keyed by URL and unchecked.
- Protected package code is stored in plaintext. Today keyhive's secrets sit
  in the same storage as its ciphertext, so this exposes nothing new;
  revisit when keyhive protects its keys at rest.
- Nothing cleans up the content store. Deduplication slows growth, and the
  existing quota warning still fires.

## Spikes before planning

- Can the service worker `postMessage` to a SharedWorker client, and can that
  worker reply with the service worker able to check its `Client.url`, in
  Chromium, Firefox and WebKit? Fallback: the worker posts answers to the
  service worker as `fetch()` requests, whose `clientId` the service worker
  can look up. Spike: `packages/e2e/spikes/sw-sharedworker`, run in CI by
  `.github/workflows/spike-sw-sharedworker.yml` (run 40640485949: Chrome 147,
  Firefox 148, Safari 26.4).

  **Answered: only the fetch path works everywhere.**

  | | Chromium | Firefox | WebKit |
  |---|---|---|---|
  | Worker is a controlled `sharedworker` client, `url` includes the query | yes | yes | yes |
  | `navigator.serviceWorker` in the worker | no | yes | yes |
  | `navigator.serviceWorker.controller` in the worker | no | null | yes |
  | Service worker `client.postMessage` reaches the worker | no | yes | yes |
  | Worker replies with `controller.postMessage`, `event.source` checkable | no | no | yes |
  | Worker replies on a port sent with the ping (`source` is null) | no | yes | yes |
  | Worker `fetch()`, `clients.get(clientId)` gives `sharedworker` and its url | yes | yes | yes |
  | Dedicated `Worker` from the same URL: same `url`, `type: "worker"` | yes | yes | yes |

  Chromium doesn't expose `ServiceWorkerContainer` in workers, so the service
  worker can't message the automerge worker at all there. In Firefox the
  worker's first `fetch()`, made while its module was still evaluating, went
  to the network instead of the service worker. Its later fetches were
  intercepted. So answers should be retried, or the worker should hold them
  until it has seen one of its own fetches answered by the service worker.
- Does automerge verify change hashes when loading a document from storage?
  **Answered: yes**, though it's planned to become optional (see
  [Remaining gaps](#remaining-gaps)).

## Testing

- Unit:
  - Path grammar: live and pinned round trips, heads sorting, segments that
    look like doc steps but aren't.
  - Providers: account namespace (union order, shadowing, fallback to
    `rootFolderUrl`), directory, folder, branches.
  - `pinPath` against a fixture folder that is renamed between versions.
  - Router: `path=` parsing and serializing; `path=` alone; `doc=`/`path=`
    disagreement.
  - `ModuleWatcher` `folder` source: add, remove, rename without reload, only
    the changed package reloading, union deduplication.
  - Migration from a module-settings doc.
  - Store and index with a fake `Cache` and an injected hash: forged store
    entry rejected, tab answer never stored, matching answer stored,
    protected non-package content never stored.
  - Manifest builder against folder and directory fixtures.
- E2E, run in CI:
  - Open a document with `&path=` alone.
  - A page `cache.put`s forged bytes under a real content key, reloads, and
    gets the real module.

## Implementation phases

Each phase can ship on its own and gets its own plan:

1. **Grammar, providers, namespace** in `patchwork-filesystem`, plus the
   account `namespace` field and its fallback. No behaviour change yet.
2. **Service worker:** `/@/` URLs, the content store, the index, the
   authenticated channel (after its spike), resolvers no longer writing the
   cache.
3. **Routing:** `&path=`, opening at a path, rebased on `open-document-path`.
4. **Packages:** the `folder` source, `/packages`, migration, deprecating
   `moduleSettingsUrl`.
