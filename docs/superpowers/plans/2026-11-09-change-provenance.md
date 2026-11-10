# Change provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Automerge change a patchwork tab makes carries `pw:<key>` naming the package version (or site build) that made it, the key's record lives in the doc, and `explain` lists a doc's changes with their writers.

**Architecture:** One wrap of the shared `DocHandle.prototype` (`change`, `changeAt`, `sub`) installed at tab setup. The wrapper reads the writer from `new Error().stack` (first frame that belongs to a package), stamps the message, and after a landed change writes the record in a change of its own through the root handle. A reader over `A.getChangesMetaSince`.

**Tech Stack:** TypeScript, `@automerge/automerge` 3.5.0, `@automerge/automerge-repo` 2.6.0-subduction.49, vitest (node environment).

**Spec:** `docs/superpowers/specs/2026-11-09-change-provenance-design.html` (published at https://claude.ai/artifact/17iHRH1mrz5BtfMpZ611pW). Read it before starting.

## Global Constraints

- Work in the worktree `../worktrees/system/provenance`, branch `change-provenance`. Stage files by name, never a directory.
- No new dependencies. No catalog bumps. The `@automerge/*` pins stay as they are.
- `core/patchwork/src/provenance/*` imports nothing from other workspace packages (only `@automerge/automerge-repo/slim` and `@automerge/automerge/slim`), so its tests run without building the workspace.
- Message: exactly `pw:<key>`, or `<caller message>\npw:<key>` when the caller passed one.
- Key: base58 alphabet `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`, 8 characters, one more per collision. Reader pattern: `/(?:^|\n)pw:([1-9A-HJ-NP-Za-km-z]{8,})$/`.
- Record: `doc["@patchwork"].writers[key] = { url: <package root> }`, written when `doc["@patchwork"]` is absent (created as `{ writers: { [key]: { url } } }`, no `type`) or a plain object whose `writers` is absent or a plain object. A non-object `@patchwork` or `writers` is left as it is.
- Site writer root: `site@<buildId>`, `buildId` read from the `__BUILD_ID__` define the way `doSetup` reads `__SITE_TITLE__` (`typeof __BUILD_ID__ === "number" ? __BUILD_ID__ : undefined`); `site@dev` when undefined.
- Stack-capture budget: under 20 µs per change in node.
- Unit tests and typechecks only on this machine. No e2e, no preview servers, no full `pnpm build`.
- Changeset: one file, `patch` for `@inkandswitch/patchwork` and `@inkandswitch/patchwork-plugins`.
- Copy and commit messages never use "I"/"my" meaning chee.

## Review Focus

1. A tool's callback throws: the error reaches the tool unchanged, no record change is made, and the next change still stamps. (Task 4 test `a throwing callback writes no record`.)
2. A callback that changes nothing: no change lands and no record change is created. (Task 4 test `an empty change makes no record`.)
3. A handle at fixed heads (`handle.view(heads)`): `change` throws its own fixed-heads error, with no record attempt. (Task 4 test `a fixed-heads handle still throws`.)
4. The stack can't be read (`Error().stack` undefined, or the stack source throws): the change goes through unstamped, and `Error.stackTraceLimit` is restored. (Task 4 test `an unreadable stack leaves the change unstamped`.)
5. A tool calls `change` inside another change's callback: both are stamped, the record change doesn't recurse through the wrapper. (Task 4 test `nested changes both stamp`.)

---

### Task 0: Worktree ready to test

**Files:** none

- [ ] **Step 1:** In the worktree run `pnpm install --frozen-lockfile`.
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest run test/router.test.ts`. Expected: PASS. If it fails because a workspace package has no `dist/`, note which, and keep every new test importing only from `src/provenance/`.

### Task 1: Stack-capture cost

**Files:**
- Create: `core/patchwork/test/provenance/stack-cost.bench.ts`

- [ ] **Step 1: Write the bench.** Two `bench` cases from vitest: `new Error().stack` read at a call depth of 30 nested functions with `Error.stackTraceLimit = 50`, and the same with the default limit. Each reads `.stack` (V8 formats lazily, so reading is the cost).
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest bench --run test/provenance/stack-cost.bench.ts`. Record the mean in µs for both cases in the commit message.
- [ ] **Step 3: Gate.** Under 20 µs: continue. Over: stop and report to chee before Task 4; the fallback is caching the writer per call site.
- [ ] **Step 4: Commit** `core/patchwork/test/provenance/stack-cost.bench.ts`, message `provenance: what reading a stack costs (<numbers>)`.

### Task 2: Frame URLs from a stack

**Files:**
- Create: `core/patchwork/src/provenance/frames.ts`
- Test: `core/patchwork/test/provenance/frames.test.ts`

**Interfaces:**
- Produces: `frameUrls(stack: string): string[]`, the URL of each frame, top of stack first, without `:line:column`.

- [ ] **Step 1: Write the failing tests.** Fixtures are literal stack strings:
  - V8: `"Error\n    at wrapped (https://pw.test/assets/index-abc.js:10:5)\n    at onClick (https://pw.test/automerge%3A2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu%237hZ5RYdE/dist/index.js:3:9)\n    at https://pw.test/assets/solid.js:1:1"` → `["https://pw.test/assets/index-abc.js", "https://pw.test/automerge%3A2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu%237hZ5RYdE/dist/index.js", "https://pw.test/assets/solid.js"]`
  - SpiderMonkey and JavaScriptCore (`fn@https://…:10:5` lines, and a bare `@https://…:1:1` line) give the same three URLs.
  - A frame with no URL (`at new Promise (<anonymous>)`, `[native code]`) is left out.
  - `frameUrls("")` → `[]`.
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest run test/provenance/frames.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `frameUrls`.** One regex over the whole string for `(?:https?|blob):\/\/[^\s()@]+?` followed by `:\d+:\d+`; keep the URL part.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** both files, message `provenance: frame urls from v8, spidermonkey and jsc stacks`.

### Task 3: Writer and key

**Files:**
- Create: `core/patchwork/src/provenance/writer.ts`
- Test: `core/patchwork/test/provenance/writer.test.ts`

**Interfaces:**
- Consumes: `frameUrls` (Task 2).
- Produces:
  - `type Writer = { root: string; key: string }`
  - `type WriterContext = { siteOrigin: string; siteRoot: string; httpSources: () => readonly string[] }`
  - `packageRoot(url: string, ctx: WriterContext): string | "site" | undefined`: a package root, `"site"` for a frame of the site itself, or `undefined` for a frame to skip.
  - `findWriter(stack: string, ctx: WriterContext): Writer | null`
  - `writerKey(root: string, length?: number): string` (default 8)

- [ ] **Step 1: Write the failing tests.**
  - `packageRoot` of `https://pw.test/automerge%3A2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu%237hZ5RYdE/dist/index.js` → `"automerge:2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu#7hZ5RYdE"` (the decoded segment, heads kept).
  - A frame under a registered http source's directory: with `httpSources: () => ["http://localhost:5173/src/main.tsx"]`, `http://localhost:5173/src/components/Draw.tsx` → `"http://localhost:5173/src/main.tsx"`. With two sources, the longest matching directory wins.
  - A frame on `siteOrigin` with no automerge segment → `"site"`. A frame on another origin matching no source (`https://esm.sh/x.js`) → `undefined`.
  - `findWriter` on the Task 2 V8 fixture → `{ root: "automerge:2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu#7hZ5RYdE", key: writerKey(that root) }` (site frames above it are skipped).
  - `findWriter` with only site frames → root `ctx.siteRoot`. With only `https://esm.sh/…` frames → `null`.
  - `writerKey` is 8 base58 characters, the same for the same root on every call, different for the two roots above, and `writerKey(root, 9).startsWith(writerKey(root))`.
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest run test/provenance/writer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The automerge segment: decode each path segment and test it with `isValidAutomergeUrl` from `@automerge/automerge-repo/slim`. The key: 64-bit FNV-1a over the root's UTF-8 bytes (BigInt), base58-encoded, padded to 11 characters, sliced to `length`. Cache `root → full 11-character encoding` in a `Map`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** both files, message `provenance: which package version a stack belongs to, and its key`.

### Task 4: The stamp

**Files:**
- Create: `core/patchwork/src/provenance/stamp.ts`
- Test: `core/patchwork/test/provenance/stamp.test.ts`

**Interfaces:**
- Consumes: `findWriter`, `writerKey`, `WriterContext` (Task 3).
- Produces:
  - `type ProvenanceOptions = WriterContext & { stack?: () => string | undefined }` (default `stack`: raise `Error.stackTraceLimit` to 50, read `new Error().stack`, restore in `finally`)
  - `installProvenance(options: ProvenanceOptions): () => void`, returning an uninstall that restores the three original methods. A second install while one is active throws `"provenance already installed"`.
  - `composeMessage(message: string | undefined, key: string): string`
  - `WRITERS = "writers"`

Behaviour of the wrapped `change(callbackOrValue, options = {})` and `changeAt(heads, callback, options = {})`:
1. Find the writer. None: call the original unchanged.
2. Pick this doc's key: start from the cached key for `documentId` + root, else `writerKey(root)`. While `fullDoc()["@patchwork"]?.writers?.[key]` exists with a different `url`, grow it one character (`writerKey(root, n + 1)`). Cache the result per `documentId` + root.
3. Heads before; call the original with `{ ...options, message: composeMessage(options.message, key) }`; heads after.
4. Heads unchanged: done. Otherwise the root handle (itself if `handle.path.length === 0`, else from the `sub` map) reads `fullDoc()["@patchwork"]`. If it is absent, or a plain object whose `writers` is absent or a plain object, and `writers[key]` is absent: the original root `change` writes `{ url: root }` there (creating `@patchwork` and `writers` as needed), message `pw:<key>`.
- The wrapped `sub(...segments)` calls the original and maps the returned handle to its root (`this` when `this.path.length === 0`, else the root mapped for `this`) in a `WeakMap`.

- [ ] **Step 1: Write the failing tests.** Each test makes `new Repo({})`, installs with `stack` returning a fixture chosen by the test (helper `stackFor(root)` building a V8 stack with one package frame), and uninstalls in `afterEach`. A doc starts as `{ "@patchwork": { type: "test" }, text: "" }` unless the test says otherwise. Read messages with `A.getChangesMetaSince(handle.doc(), [])`.
  - `stamps a change`: one change → its message is `pw:<key>`.
  - `keeps a caller's message`: `{ message: "rename layer" }` → `"rename layer\npw:<key>"`.
  - `records a writer once`: two changes from one root → `@patchwork.writers[key]` is `{ url: root }`, and exactly one change besides the two tool changes exists.
  - `records two writers`: changes from two roots → two records.
  - `value form`: `handle.sub("text").change("hi")` is stamped and recorded through the root.
  - `changeAt`: stamped and recorded.
  - `sub-handle`: `handle.sub("items").change(d => …)` is stamped; the record lands on the root doc.
  - `no @patchwork, one is created`: a doc `{ text: "" }` gets the stamp, and `@patchwork` deep-equals `{ writers: { [key]: { url: root } } }`.
  - `@patchwork not an object`: `@patchwork` set to `"x"` is left as `"x"`; the change is still stamped.
  - `writers not an object`: `@patchwork.writers` set to `"x"` is left as `"x"`.
  - `a collision grows the key`: pre-write `writers[writerKey(rootA)] = { url: "other" }`; a change from rootA is stamped with `writerKey(rootA, 9)` and recorded under it.
  - `handle identity`: `repo.find(url)` returns the same object before and after install, and `handle.sub("x") === handle.sub("x")`.
  - `uninstall restores`: after uninstall a change has `message: null`.
  - The five Review Focus tests: `a throwing callback writes no record` (the thrown error is `===` the tool's), `an empty change makes no record` (`handle.change(() => {})` adds no change), `a fixed-heads handle still throws` (`handle.view(handle.heads()).change(...)` throws, and no change is added), `an unreadable stack leaves the change unstamped` (`stack: () => undefined` and `stack: () => { throw new Error() }` both give `message: null`; `Error.stackTraceLimit` equals its value before), `nested changes both stamp` (a change on handle A whose callback changes handle B: both messages carry the key).
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest run test/provenance/stamp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `stamp.ts`** as described above. Patch `DocHandle.prototype` from `@automerge/automerge-repo/slim`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** both files, message `provenance: stamp every change with its writer, record it once per doc`.

### Task 5: The reader

**Files:**
- Create: `core/patchwork/src/provenance/explain.ts`, `core/patchwork/src/provenance/index.ts` (re-exports Tasks 3-5's public names)
- Test: `core/patchwork/test/provenance/explain.test.ts`

**Interfaces:**
- Consumes: `installProvenance` (tests only).
- Produces:
  - `type ExplainedWriter = { url: string } | "unrecorded" | null`
  - `type ExplainedChange = { hash: string; time: number; actor: string; message: string | null; key: string | null; writer: ExplainedWriter }`
  - `explain(handle: DocHandle<unknown>, options?: { limit?: number; since?: A.Heads }): ExplainedChange[]` (newest first; `limit` default 50)
  - `type WriterSummary = { key: string | null; writer: ExplainedWriter; count: number; first: number; last: number }`
  - `explainSummary(handle: DocHandle<unknown>): WriterSummary[]` (whole history, most changes first)
  - `parseMessage(message: string | null): { message: string | null; key: string | null }`

- [ ] **Step 1: Write the failing tests.**
  - `parseMessage("pw:4kQx9TmB")` → `{ message: null, key: "4kQx9TmB" }`; `"rename layer\npw:4kQx9TmB"` → `{ message: "rename layer", key: "4kQx9TmB" }`; `"pw:4kQx"` (too short) → `{ message: "pw:4kQx", key: null }`; `null` → both null.
  - A doc with: one change made before install (no key), three from rootA, one from rootB, one on a doc whose `@patchwork` is `"x"` for the `"unrecorded"` case. `explain` gives newest first, `writer` `{ url: rootA }` / `{ url: rootB }` / `null` as made; the record changes themselves show their writer too.
  - `limit: 2` returns two rows; `since: <heads after the first change>` leaves the first change out.
  - `explainSummary`: rootA's row has `count` equal to its tool changes plus its record change, and `first <= last`; the pre-install change's row has `key: null`.
- [ ] **Step 2:** Run `pnpm --dir core/patchwork exec vitest run test/provenance/explain.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `explain` reads `A.getChangesMetaSince(handle.doc(), since ?? [])` (order its output by `time`, then `seq`, descending, if it isn't already newest first) and looks keys up in `handle.doc()["@patchwork"]?.writers`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** the three files, message `provenance: explain a doc's changes by writer`.

### Task 6: Wire it into setup

**Files:**
- Modify: `core/plugins/src/registry/index.ts` (add the export), `core/plugins/src/index.ts` if it re-exports the registry names explicitly
- Modify: `core/patchwork/src/index.ts` (install in `doSetup`, add to the returned object, export the provenance names)
- Modify: `core/patchwork/src/types.ts` (`Patchwork` gains the two fields)
- Create: `.changeset/change-provenance.md`

**Interfaces:**
- Consumes: `installProvenance`, `explain`, `explainSummary` (Tasks 4, 5); `sourceOf` stays where it is.
- Produces:
  - `pluginImportUrls(): string[]` from `@inkandswitch/patchwork-plugins`: every registered plugin's `importUrl` across every registry, without duplicates.
  - `Patchwork.explain(target: AutomergeUrl | DocHandle<unknown>, options?: { limit?: number; since?: Heads }): Promise<ExplainedChange[]>` and `Patchwork.explainSummary(target: AutomergeUrl | DocHandle<unknown>): Promise<WriterSummary[]>`, which `repo.find` a url first.

- [ ] **Step 1:** Add `pluginImportUrls` to `core/plugins/src/registry/index.ts`, beside `removeFromSource`, which already walks `registries`.
- [ ] **Step 2:** In `doSetup`, straight after the `repo` is chosen (both the `options.repo` and `createRepo()` branches) and before `registerPatchworkViewElement`, call `installProvenance({ siteOrigin: location.origin, siteRoot: \`site@${buildId ?? "dev"}\`, httpSources: () => pluginImportUrls().filter(isHttpUrl) })`. `isHttpUrl` comes from `@inkandswitch/patchwork-filesystem`; `buildId` is read from `__BUILD_ID__` as in the global constraints (it's declared in `core/patchwork/src/client.d.ts`).
- [ ] **Step 3:** Add `explain` and `explainSummary` to the object `doSetup` returns and to `Patchwork` in `types.ts`, with a one-line doc comment each, saying they read which package version made a doc's changes. Export `explain`, `explainSummary`, `parseMessage` and their types from `core/patchwork/src/index.ts`.
- [ ] **Step 4: Write the changeset** `.changeset/change-provenance.md`:

```markdown
---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
---

Changes made in a patchwork tab now say which package version made them. Each change's message carries `pw:<key>` (after the caller's own message, if it gave one), and the first change a package version makes to a doc is followed by one that records the key under `@patchwork.writers`, creating `@patchwork` when the doc has none. `explain(handle)` and `explainSummary(handle)` read it back, and `setup()`'s result has both, taking a url or a handle. `@inkandswitch/patchwork-plugins` exports `pluginImportUrls()`.
```

- [ ] **Step 5:** Typecheck: `pnpm --filter @inkandswitch/patchwork... build`. Expected: exit 0. If that pulls in more than the core packages, or memory runs short, stop and let CI build, per the global constraints.
- [ ] **Step 6:** Run `pnpm --dir core/patchwork exec vitest run` and `pnpm --dir core/plugins exec vitest run`. Expected: PASS.
- [ ] **Step 7: Commit** each modified file and the changeset by name, message `provenance: install at setup, explain on the patchwork object`.
