# Paths, namespace, and a content-addressed package cache

Status: design, approved in conversation 2026-10-28. Revised the same day:
pinned URLs now name a hash of their folder's file list, so a pinned URL is
checked against itself and nothing else (sections 1 and 5). Phase 1 is
implemented. Phase 2 was implemented against the earlier section 5 (an index
in service worker memory, filled by the automerge worker over an
authenticated channel) and gets reworked to this one.

## Goals

- Clicking an item in the sidebar sets `&path=` in the hash to a readable path
  rooted at the account, and a tool can be opened at a path.
- Paths are real: the service worker serves them, packages are imported
  through them, and the filesystem is a namespace rather than only the
  `.docs` walk of the root folder.
- Package management is a folder: whatever is bound at `/packages`.
- URLs don't carry raw document ids unless a portable share link is wanted,
  and neither does anything in the content store.
- The package cache can't be poisoned by a crafted link, by code running on
  the origin writing to CacheStorage, or by a stale name resolution.

## Non-goals

- Cache isolation between two accounts in the same browser profile.
- Running package code on a separate origin. This design is meant not to
  preclude it (the store and file lists work the same there), but doesn't do it.
- Mount points below the top level of the namespace.
- Garbage collection of the content store.

## Threat model

| Attacker | In scope | What stops it |
|---|---|---|
| A crafted link makes the service worker cache content under a key your own imports later hit | yes | Content is stored only under its own hash, after hashing it; a crafted link can only name other content |
| Code on the origin (a package or tool) writes to CacheStorage | yes | Every store read is hashed and compared with a hash that comes from the URL, directly or through a file list that is itself checked against the URL |
| A name path resolved once keeps serving old content | yes | Names are never stored; a pinned URL carries the heads of each folder and the hash of its file list, so it can't change meaning |
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
- **listHash**: the SHA-256, in base64url, of a container's **file list**
  (section 5): every file the URL may reach below that container, with the
  hash of its bytes and the heads it was read at. base64url has no `@`, `.`
  or `~`.

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
4. The names after the last container (a folder, a directory, …) lead to a
   **file**: a value inside the container, or a document reached by a link.
   They stay names, so a module's relative imports (`./util.js`, `../x.js`)
   resolve against them. A link without heads doesn't pin the file it leads
   to, so the container's step carries `~<listHash>`, and the list records
   each file's hash and heads. Links don't need to carry heads.

```
live:    <acctHash>/Projects/foo/dist/index.js
pinned:  <acctHash>@h/<rootHash>@h/<projectsHash>@h/<fooHash>@h~<listHash>/dist/index.js

live:    <acctHash>/packages/foo/dist/index.js
pinned:  <acctHash>@h/packages/<myPackagesHash>@h/<fooHash>@h~<listHash>/dist/index.js
```

Which containers carry a list:

- `pinPath` puts one on the last container.
- Pinning a package (phase 4) puts one on every container from the
  package's own step down, so `../` between a folder package's subfolders
  stays pinned.
- A file reached under a container step with no list is resolved live,
  served `no-store`, and never stored or checked.

When resolving, a segment is a doc step if it parses as
`<base58>@<heads>` or `<base58>@<heads>~<listHash>` and a link reachable
from the current node hashes to that idhash; otherwise it's a name.

The first segment of a pinned path is either an acctHash the resolver knows
locally, or `automerge:<documentId>@<heads>` for a portable share link (safe
to hand out once the doc is on keyhive, since the id no longer grants
access). The `automerge:` prefix is what tells the two apart.

A pinned path never changes meaning, so whoever builds an import URL builds
the whole chain, and its file lists, first.

No raw document id appears in a live or pinned path: every step is an
idhash. The only exception is a share link's root, which carries one on
purpose. Nothing in a module graph goes through a redirect: the
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

These built-ins run in every resolver, the automerge worker's included.
Nothing trusts a provider's answers, since every byte is checked against the
URL. Packages can supply providers too (section 6), but they run only in
tabs, after the built-ins, and only for documents a walk goes through.

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
root. Tabs register it with the worker at boot. The worker computes the
acctHash from the url itself, so no tab can register an account under
another's hash.

## 3. Service worker URLs and routing

### URLs

All new forms live under a reserved prefix, so no site file can be mistaken
for a path:

```
/@/<live path>      e.g. /@/<acctHash>/Projects/foo/x.js
/@/<pinned path>    e.g. /@/<acctHash>@h/<rootHash>@h/.../<fooHash>@h~<listHash>/x.js
```

- A **live** URL answers with a 307 to its pinned form, computed by a
  resolver. Fine for `fetch()`; never use one for `import()`. The pinned
  form's list covers only the file asked for, so a redirect costs one file
  read, not a folder's worth (section 5, *File lists*).
- A **pinned** URL is served from the content store, checked against its
  own list (section 5).
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
  importing, and the file list it names (section 5)

## 4. Packages via `/packages`

- Package management is whatever is bound at `/packages`. The folder can live
  anywhere in the tree, or nowhere.
- `ModuleWatcher` gets a third source kind, `folder` (alongside automerge
  module-settings docs and HTTP manifests), pointed at the `/packages` union:
  - The module list is the union listing, deduplicated by document id. Two
    packages with the same name both load; the name only decides which one a
    path lookup finds.
  - Packages are tracked by document id, so a rename doesn't reload anything.
  - When a package's own heads move, the watcher looks it up again, gets a
    new pinned URL, and imports that. A push that changes only files behind
    links without heads must still touch the package doc; pushwork already
    bumps `lastSyncAt` for that.
  - The lookup is a live URL through the union member that holds the
    package: `/@/<acctHash>/packages/<memberIdhash>@<heads>/<name>`. That
    finds a shadowed package too. A resolver answers with a 307 to the
    package's pinned URL. The watcher imports the package as an http
    package from that URL: `package.json`, then its entry, both checked
    against the list.
  - A package's list is **deep**: a container with a `package.json` file
    lists every file under it, through nested folders. A folder package's
    `./sub/x.js` is reached by name, not by a doc step, so it has to be in
    the package's own list. Other containers list only their own files.
  - A live → pinned redirect to a **container** carries that container's
    whole list (deep, for a package). A redirect to a file carries only that
    file's. A file in a nested folder is read through a link without heads,
    so a resolver reads at a list's `heads` whether or not the path is
    canonical. Other packages keep their existing URLs: a
    pinned URL stays valid forever, so a change elsewhere in the chain
    doesn't reload them.
  - `PackageTracker.findLatest` keeps asking the service worker, in the new
    grammar.
- The site's `system` HTTP manifest stays a separate source.
- So does the module-settings doc, for now. The Packages UI (an installed
  tool, not in this repo) still installs into it, so the watcher loads both
  it and `/packages`, deduplicated by document id. A package in both is
  imported through `/packages`.
- A link under `/packages` that isn't a package (no `package.json`) is
  warned about and skipped.

### Accounts

- `createDefaultAccount` binds `/` to the root folder and `/packages` to a new
  folder.
- Migration, once at boot: if the account has `moduleSettingsUrl` and no
  `/packages` binding, create a folder, add a link for each automerge entry
  (named by `package.json` `name`, falling back to the doc title), and bind
  it at `/packages`. The module-settings doc is left untouched.
- Packages installed through the old Packages UI after the migration still
  land in the module-settings doc, which this build keeps reading, but not
  in `/packages`. Builds older than this one never see `/packages`.
- `AccountDoc.moduleSettingsUrl` is deprecated in favour of the `/packages`
  binding.

## 5. Content store and file lists

### Store

- A CacheStorage cache named `patchwork-content-<acctHash>`, separate from
  the `patchwork` cache that holds site pages and assets.
- Key: `/.content/<sha256 base64url>`, an internal key that is never fetched.
- Value: the bytes only. The content type lives in the file list, so
  identical bytes are stored once whatever their type.
- Reads and writes go through one small interface (`get(hash)`,
  `put(hash, bytes)`), so entries can later be encrypted under an at-rest key.
- Anything on the origin can write it. That's fine: every read is hashed and
  compared with a hash the URL vouches for, and a mismatch is deleted.
- `clearAccountStore(acctHash)` deletes the cache. There is no sign-out flow
  today; a site calls this from its own.

### File lists

A container's file list says what each file under it is, at the moment it
was pinned. It is canonical JSON: keys sorted, no whitespace.

```json
{"files":{"dist/index.js":{"heads":"a.b","sha256":"…","store":true,"type":"text/javascript"},"package.json":{…}},"v":1}
```

- **Keys** are tails: the names below the container, each
  `encodeURIComponent`-encoded and joined with `/`. The container itself is
  `""`.
- **Entries:**
  - `sha256` is the hash of the bytes the file serves as.
  - `type` is its content type.
  - `heads` is the heads its document was read at. It's absent for a value
    inside the container, which the container's own heads pin.
  - `store` says whether the bytes may be kept (see
    [What gets stored](#what-gets-stored)).
- **No document ids, by design.** A resolver that needs a file's bytes walks
  to it by name from the container at its pinned heads, and reads it at the
  recorded heads. Automerge keeps history, so an old version stays readable
  wherever the document is.
- **The listHash is the SHA-256 of these bytes.** The list is content like
  any other: stored under its hash if its container's content may be stored,
  and otherwise held in service worker memory.
- **A list may cover only some of a container's files.** A package's list
  covers all of them, so relative imports work. The list behind a live →
  pinned redirect covers only the file asked for. A tail a list doesn't
  cover answers 404.
- **Whoever pins builds the list** (`pinPath`): it loads each file once and
  hashes it. A tab or the automerge worker, it doesn't matter which: a list
  is checked against the URL, not trusted for who made it.
  - The pinner writes the list into the store itself when it may be stored.
  - Otherwise it hands the list to the service worker in a message, or with
    the 307 it answers.
  - The service worker hashes the list before keeping it in memory.

### What gets stored

- Content, file lists included, from unprotected documents
  (`isUnprotectedDocId`).
- Content from keyhive-protected documents only when reached through
  `/packages`. Package code needs to load fast at boot; user documents don't.
- Everything else is served after checking, never stored.

### Request flow for a pinned URL

1. **The list:**
   - Read the last container's list by its listHash: from the store, or
     from memory.
   - Hash it.
   - On a miss, or a mismatch (delete the store entry and warn), ask a
     resolver to build that container's list at its pinned heads. Keep the
     answer only if it hashes to the listHash.
   - No list: fail as a network error.
2. **The entry:** look the tail up in the list; not there, 404.
3. **The bytes:**
   - Read the store by the entry's `sha256` and hash the bytes. A match
     serves them; a mismatch deletes the entry, warns, and goes on.
   - Ask a resolver for the file at its pinned path and the entry's `heads`,
     and hash its bytes.
   - A match serves them, and stores them if the entry allows it. A
     mismatch fails as a network error and stores nothing.

A container step with no list leads to files resolved live: served
`no-store` from a resolver, never stored, not checked.

Hashing is `crypto.subtle` SHA-256 on every hit, since a store entry can
change between two reads. `sites/bench` gets a case measuring it.

Cold start needs no document: a package's list and its files are both in the
store, and both are checked against the URL the watcher pinned.

### Who is trusted for what

- **Nothing between the URL and the bytes is trusted.** Lists, store
  entries, and resolver answers from a tab or the automerge worker are all
  checked against hashes that start at the URL. A forged answer can fail a
  request, but it can't change what's served.
- **Whoever builds a URL chooses the version it names.** For imports that's
  the tab's own ModuleWatcher. For a live → pinned redirect it's whichever
  resolver answered (see [Remaining gaps](#remaining-gaps)).
- **No authenticated channel is needed.** The earlier design filled an index
  from the automerge worker over `fetch()` requests checked by `clientId`.
  The spike behind that is kept below, in case a later design needs to know
  who sent something.
- **Legacy `/automerge%3A…` URLs** stay keyed by URL and unchecked. Their
  replies still ride `HANDOFF_CHANNEL`, which any context can answer first.

## 6. Package-supplied path providers

Approved in conversation 2026-10-28. Implemented in `patchwork-filesystem`
(`sub` children, the editing methods, `WalkOptions.providers`),
`patchwork-plugins` (`pathProviderFor`, `packagePathProviders`,
`pathProviderTypes`), the tab resolver and the router, and the base
sidebar. The built-in folder provider doesn't offer editing yet. In the
sidebar, a document dropped among an opened provider's children is added
(linked) and left where it was. The row itself still takes drops as a folder
entry. Files, new documents and sub-documents can't be dropped among a
provider's children.

The sidebar can open up a doc that isn't a folder when a built-in provider
walks it: a directory doc, a branches doc, the account. This section proposes
letting a datatype say what its children are too: a tldraw doc's embedded
docs, say, or the docs a markdown doc links to. It lifts the non-goal
"Path providers supplied by packages".

### The plugin

A `patchwork:path-provider` plugin is a `PathProvider`: `matches`, `lookup`
and `list`, exported from `patchwork-filesystem` already. A datatype package
registers one beside its datatype.

- **Built-ins come first and can't be overridden.** Account, directory, folder
  and branches are checked first; package providers after, in registration
  order. A package can't take over how folders resolve.
  - One exception: the folder built-in matches anything with a `docs` array,
    so a typed document that keeps one (a tldraw canvas holds its scripts
    there) would never reach its own type's provider. Such a document is
    walked by a provider declared for its type, if there is one, and as a
    folder otherwise. An untyped or `folder`-typed folder is always the
    built-in's. A provider for such a type should list the `docs` entries as
    the folder provider does, so paths into them pin the same either way.
- **It's a pure function of the document.** `list` and `lookup` read only the
  node they're given, at the heads they're given. That's what lets a file
  list built through a provider be rebuilt to the same bytes.
- **It says which datatypes it walks** with `supportedDatatypes`, as a tool
  does. That's how the sidebar knows a row of that type can open up, from its
  link's `type`, without loading the doc.

### Where it runs: tabs only

The automerge worker never loads package code, so it never runs package
providers. A tab does: its sidebar, its walks, and its resolver.

- **The service worker asks tabs first.** Live → pinned redirects and reads at
  heads through a package provider are answered by a tab. A page made the
  request, so there is one.
- **`/packages` is the worker's.** Tabs decline it (section 4), so package
  providers don't apply under `/packages`. Packages are folders and
  directories anyway.
- **A pinned URL needs a tab to rebuild its list.** If a pinned URL goes
  through a package provider and its list is lost, only a tab with that
  provider loaded can rebuild it. Without one, it fails as a network error.

### Trust

Nothing between a URL and its bytes trusts a provider (section 5). A file list
built through one is checked against the URL; bytes are checked against the
list.

What a provider *can* do is the same as any package code in a tab:
- name the wrong children in the sidebar;
- resolve a live path to a document it shouldn't;
- by being pinned, choose the version a URL names.

That's the "whoever builds a URL chooses its version" gap, applied to
providers. It adds no access a package doesn't already have.

### Versions

A new version of the providing package can change what a live path resolves
to. Pinned paths don't change. A package's provider applies only to a document a walk
goes on *through*. Whether a document a path ends at is a container or a
file, and what a file list counts as a file, are the built-ins' call. So a
path pins to the same URL with or without the provider, and a provider
installed later doesn't change a URL pinned before it. A list rebuilt through a changed provider won't
match its hash, so the URL fails rather than serving something else.

### What a provider offers

The sidebar shows what a provider offers and no more. Two things are optional.

**Editing.** A provider may implement any of these:
- `add(handle, node, child, index?)`;
- `rename(handle, node, name, to)`;
- `remove(handle, node, name)`.

Each takes the doc's handle and changes the doc. The sidebar turns on Rename,
Remove, drops and new-doc only where the provider offers them. A child of a
provider that offers none is read-only, as directory and branches children are
now.

The built-in folder provider would offer all three. That would make the
sidebar's folder editing one case of this rather than its own code path,
though there's no need to move it yet.

**Values as sub-documents.** A child that is a value inside the doc, not a
link, can be offered as a sub-document:
- `{ name, sub: [...segments] }` is opened as automerge-repo's sub-handle,
  `handle.sub(...segments)`, at the URL `automerge:<docId>/<path>`;
- the tool gets that handle, so it edits just that part of the doc;
- the live path names it as an in-doc step (rule 3): a plain name after the
  doc's own step, pinned by the doc's heads.

Values a provider doesn't offer as sub-documents stay hidden, as now.

## Remaining gaps

These replace the deleted `package-load-gate.md` note.

- Offline, `servePassthrough` falls back to the URL-keyed `patchwork` cache,
  which any code on the origin can write. Site assets, the automerge worker's
  script included, come from there.
- Packages can write the automerge worker's IndexedDB/OPFS storage.
  Automerge verifies change hashes when it loads a document, so tampered
  changes don't load as the heads they claim. That check is planned to become
  optional; when it does, this gap reopens unless patchwork keeps it on.
- Whoever builds a pinned URL chooses its version. A live → pinned redirect
  answered by a tab can name a wrong version, and so can a package that
  builds import URLs for another. It can't poison the store, but it decides
  which version gets loaded.
- A pinned URL can't be served if its file list is gone (evicted, cleared,
  or held only in a service worker that stopped) and no resolver can
  rebuild it. A rebuild reads each file at its current heads, so it matches
  only if nothing changed since. It tries the one-file list a redirect hands
  out first, then the whole container's, so a reloaded page rebuilds as
  cheaply as it was pinned. The ModuleWatcher pins again on boot, so
  imports recover; a hand-made share link doesn't.
- Legacy `/automerge%3A…` URLs stay keyed by URL and unchecked.
- Protected package code is stored in plaintext. Today keyhive's secrets sit
  in the same storage as its ciphertext, so this exposes nothing new;
  revisit when keyhive protects its keys at rest.
- Nothing cleans up the content store. Deduplication slows growth, and the
  existing quota warning still fires.

## Spikes before planning

- (For the earlier, index-based section 5. Not needed now, but kept.) Can
  the service worker `postMessage` to a SharedWorker client, and can that
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
  - File lists: canonical bytes (key order, no whitespace), tails for folder
    and directory fixtures, no document ids, and a list that agrees with
    `readPath` for every file it covers.
  - The request flow with a fake `Cache` and an injected hash:
    - a forged list or store entry is rejected;
    - a resolver's mismatching bytes fail as a network error and are never
      stored;
    - a file read at its recorded heads after it has changed still serves
      the old bytes;
    - protected non-package content is never stored;
    - a tail the list doesn't cover answers 404.
  - The service worker itself, in node, against a fake global scope
    (`core/bootloader/test/service-worker-harness.ts`).
- E2E, run in CI:
  - Open a document with `&path=` alone.
  - A page `cache.put`s forged bytes under a real content key, reloads, and
    gets the real module.

## Implementation phases

Each phase can ship on its own and gets its own plan:

1. **Grammar, providers, namespace** in `patchwork-filesystem`, plus the
   account `namespace` field and its fallback. No behaviour change yet.
2. **Service worker:** `/@/` URLs, the content store, resolvers no longer
   writing the cache. Done against the earlier index-based section 5; the
   rework replaces the index, the manifest handler and the authenticated
   channel with file lists.
3. **Routing:** `&path=`, opening at a path, rebased on `open-document-path`.
4. **Packages:** the `folder` source, `/packages`, migration, deprecating
   `moduleSettingsUrl`.
