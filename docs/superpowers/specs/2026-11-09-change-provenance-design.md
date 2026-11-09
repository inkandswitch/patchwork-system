# Change provenance

Every Automerge change made in a patchwork tab says which package version made it, so a developer
can answer "which tool broke this doc?" from the doc alone. Taken from ermine, where every write
carries its actor, frame and site and `explain()` reads them back.

## Goal

- Every change a tab makes carries a short key naming the package version (or site build) that made
  it.
- The key's full record lives in the doc, so anyone who can read the doc, collaborators included,
  can resolve it.
- A console-level reader lists a doc's changes with their writers.

First reader: a developer debugging a doc. Not in scope: per-field blame, any UI, reverting a
writer's changes, stamping changes made inside workers.

## Cost

Measured on astrobleme, `@automerge/automerge` 3.5.0, 5 alternating rounds
(`~/tmp/ambench/provenance.mjs`, results `prov.jsonl`):

| per change, 5000 typing changes | no message | `"tldraw"` | ~150 B JSON |
|---|---|---|---|
| `change()` | 22.3 µs | 22.7 µs | 23.3 µs |
| sync round trip | 730 µs | 723 µs | 730 µs |
| incremental save | 108 B | 114 B | 259 B |
| sync bytes | 262 B | 268 B | 414 B |

Compacted saves deduplicate messages (5000 identical full messages: +157 B), but incremental
chunks and sync messages carry each change's message whole. Hence a short key in the message and the
full record written once per doc.

## 1. Attribution: finding the writer

At tab setup, before any package loads, `DocHandle.prototype.change` and `changeAt` are wrapped
once. `@automerge/automerge-repo` is a single external per realm, so the wrap covers tools, components
writing through the base repo, and handles shared between views, and handle identity is untouched.
Wrapping handles per view was rejected: components receive the base repo, and `repo.find` returns
one shared handle per doc.

`change` runs its callback synchronously, so the calling tool is on the stack. The wrapper captures
`new Error().stack` (with `Error.stackTraceLimit` raised for the capture and restored after) and
walks its frames for the first URL that belongs to a package:

| frame URL | package root |
|---|---|
| `${origin}/automerge%3A<id>%23<heads>/…` (main) | `automerge:<id>#<heads>` |
| `${origin}/@/<pinned path>/…` (`paths-design`) | the pinned container path |
| an http(s) URL whose source a plugin was registered from (dev servers) | that source, via the registry's `sourceOf` |

Walking past the first frame skips shared externals (solid-automerge, the React hooks), whose frames
belong to the site, to the tool frame that called them. With no package frame, the writer is the
site build, root `site@<buildId>`. A stack with no frame from the site or a package (an extension,
`eval`) gets no stamp.

The record names a package version, not a tool: a frame shows which package wrote, not which of its
plugins.

## 2. What a change carries

- Key: the first 8 base58 characters of a hash of the package root. Computed once per root and
  cached.
- Message: `pw:<key>`. When the caller passes its own message, the key goes on a new line after it:
  `<message>\npw:<key>`. Readers match `/(?:^|\n)pw:([1-9A-HJ-NP-Za-km-z]{8,})$/` (longer after a collision, section 3).

## 3. The record

On a package version's first write to a doc, the same change also writes

```ts
doc["@patchwork"].writers[key] = { url: "<package root>" }
```

- Written only when `doc["@patchwork"]` is already an object. A doc without it gets the message
  and no record, since adding `@patchwork` would make it look like a typed patchwork doc.
- Written only where the wrapper sees the root doc: the callback form of `change`, `changeAt`, and
  sub-handle changes if they reach the root handle's `change` with a root callback (checked in the
  plan). The value shorthand of `change` gets the message and no record.
- An existing record under the key with a different `url` is a key collision. The wrapper then keys
  this writer with one more hash character until free, and caches that per doc.
- A dev loop that rebuilds a package adds one record per rebuild that writes, about 150 B each.

## 4. Reading

From `@inkandswitch/patchwork`:

```ts
explain(handle, { limit = 50, since?: Heads }): ExplainedChange[]
explainSummary(handle): { writer, count, first, last }[]
```

`explain` reads `A.getChangesMetaSince(doc, since ?? [])` (metadata only, ops not decoded), newest
first, and returns `{ hash, time, actor, message, key, writer }`:

- `message`: the caller's own text with the `pw:` line removed, or `null`
- `writer`: `{ url }` when the key resolves through `@patchwork.writers`; `"unrecorded"` for a key
  with no record; `null` for no key (made before this landed, or by an unstamped writer)

`explainSummary` groups `explain`'s rows over the whole history by writer, with a count and the first
and last time each one wrote. Sites expose both on `window.patchwork`, so `await
patchwork.explain(url)` works from the console.

## 5. Placement

`core/patchwork/src/provenance/`:

- `frames.ts`: stack string to frame URLs, for V8, SpiderMonkey and JavaScriptCore formats
- `writer.ts`: frame URL to package root and key; the key cache
- `stamp.ts`: the prototype wrap, message and record
- `explain.ts`: the reader

Installed from tab setup, beside the `Repo` construction in `core/patchwork/src/repo.ts`. One
changeset, `patch` for `@inkandswitch/patchwork`: changes made in a tab now carry `pw:` keys,
docs with `@patchwork` gain `@patchwork.writers`, and `explain` / `explainSummary` are new exports.

## 6. Testing

Vitest only; browser coverage comes from CI's e2e.

- First: a stack-capture microbench. Budget under 20 µs per change (a sync round trip is ~730 µs). Over
  budget, cache the writer per call site before going further.
- `frames.ts`: captured stack strings from all three engines, including frames of shared externals and
  the site bundle.
- `writer.ts`: each URL form (main, `/@/`, http dev source, site), key stability, collision suffix.
- `stamp.ts` against a real in-memory `Repo`, with the frame source injected so a test chooses the
  stack: first write records, later writes don't; a caller's message is kept; value shorthand gets a
  message and no record; `changeAt` and sub-handles; a doc without `@patchwork` gets no record; handle
  identity unchanged.
- `explain.ts`: a doc with mixed writers, changes from before this landed, `since`, `limit`.
