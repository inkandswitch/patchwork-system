# Plan: undo and redo as a service of Patchwork

This file is a work plan for one contributor. It lives on the branch `plan/document-undo`; delete it in the last commit before opening a pull request (the proposal it asks for stays).

## Goal

Every Patchwork tool gets undo and redo of its document edits from Patchwork itself, with a few lines of code, instead of each tool shipping its own history. Deliverables:

1. A library, `@inkandswitch/patchwork-undo` (`packages/undo`): the undo engine on Automerge documents.
2. Host integration: one page-wide key binding (Mod+Z, Mod+Shift+Z, Mod+Y outside macOS) and a provider through which tools and host UI (an Edit menu, a toolbar button) reach a document's history.
3. Small helpers for the common editors (CodeMirror, tldraw), framework bindings (React, Solid) next to the existing provider bindings, and tested example tools.
4. Extensive tests: unit, property/fuzz, comparison against CodeMirror's own history, and Playwright end-to-end tests with two browser profiles.
5. A proposal document in the style of a high-quality PEP (see "The proposal").
6. A changeset (see `AGENTS.md`).

## Why

Undo is the feature every editing tool needs and almost every tool gets subtly wrong in a collaborative system:

- **Each tool reimplements it.** Text tools wrap CodeMirror's `history()`, canvas tools use tldraw's `HistoryManager`, form-based tools usually have none at all. Each must separately learn that remote changes must not be undoable, and that a draft swap (an `OverlayHandle` getting a new backing, signalled by `scopeReplaced` on the `change` event) invalidates its stack.
- **Histories don't compose.** Two tools on one document (a code pane and a visual editor of the same file, two panes) each undo only what went through them, though the user sees one document.
- **Automerge already has the information.** Every change records its actor, and each realm loads documents with its own actor, so "my changes" is well defined per tab, and an undo can be a new change that reverts only those, leaving collaborators' work alone. Yjs and Loro ship this as an `UndoManager` for exactly this reason ("By default, all local changes that don't specify a transaction origin will be tracked", [Yjs](https://docs.yjs.dev/api/undo-manager); "it should only undo/redo local operations without affecting other collaborators' edits", [Loro](https://github.com/loro-dev/loro-docs/blob/main/pages/docs/advanced/undo.mdx)). Automerge removed its undo in 1.0 ([automerge#985](https://github.com/automerge/automerge/issues/985)), so Patchwork, which owns the realm and the documents, is the natural place for it.
- **Productivity:** a tool that writes to its document gets correct, collaborative, draft-aware undo by calling one function, and its users get the same keys and the same behaviour everywhere.

## The semantics to implement

These were validated in a prototype across a CodeMirror text editor, a tldraw canvas and a structured editor with two views of one document, including the comparisons and fuzzing described below. Implement them; deviate only with a recorded reason.

### Whose changes, which history

- **One history per realm and document**, shared by every tool in the realm that edits that document. A change belongs to the realm if its actor is the document's actor in this realm (`Automerge.getActorId(doc)`, compared with `getChangesMetaSince(doc, lastHeads)[i].actor`). Two tabs, or two realms, of one user undo independently.
- **Key the history by the backing handle**, not by the presented url: an `OverlayHandle` (draft) and the base handle are different histories. When a handle's backing is swapped (`scopeReplaced`), reset that history, as tools do today.
- **The handle must be a root handle**: the engine needs the whole document (actor, change history). For a sub-handle, use its root; check how `sub()` handles relate to their root in automerge-repo and in `OverlayHandle`.
- **Ignored paths**: changes only to ignored paths neither form steps nor end an undo run, and the inversion leaves them alone. Defaults: top-level keys starting with `@` (Patchwork metadata such as `@patchwork`, comments such as `@comments`). Tools add their own: tldraw keeps a `user:…` record in `store` that it re-creates immediately whenever an undo deletes it; unless ignored, that re-creation ends every undo run and redo never works.

### Steps

- Consecutive local changes less than `groupDelayMs` (default 500, as CodeMirror's `newGroupDelay` and Yjs's `captureTimeout`) apart form one step, **and** a text edit joins the step only if it touches the range of the step's last edit (CodeMirror's `isAdjacent`). Compute the ranges from the change's patches (`Automerge.diff(doc, change.deps, [hash])`): for each patch on a sequence, the touched index range before and after the change.
- `checkpoint()` ends the current step; tools call it where they know a boundary. CodeMirror: before a user transaction that changes the document and isn't typing or deleting (`!tr.isUserEvent("input.type") && !tr.isUserEvent("delete")`, e.g. a paste), and on a selection-only user transaction (`tr.isUserEvent("select")`). Do it from an `EditorState.transactionExtender`, which runs before automerge-codemirror writes the change; an update listener runs too late. tldraw: at every history mark; all marks go through `editor.history._mark(id)`, so wrap that (internal, so pin and test it), and set `groupDelayMs: Infinity` so a long drag stays one step.

### Undo runs (the "great undo-redo quandary")

Linear undo normally loses the redo branch when the user edits after undoing ([TheGURQ](https://github.com/zaboople/klonk/blob/master/TheGURQ.md)). Instead:

- Consecutive undo/redo presses form a **run**: a pointer that walks back (undo) and forth (redo) through the steps. Each press is applied **at once** as a new change and synced, so collaborators see what the user sees.
- The next local change that isn't an undo or redo ends the run. If the run ended away from where it started, all its changes become **one new step** on top of the history; if it returned to its start, it leaves no step. Redo exists only inside a run. Undoing the run's step later restores what it undid, so no state is ever unreachable.
- A step whose inverse changes nothing visible (typing a character and deleting it within one step; writing a value equal to the old one) is **skipped**, in both directions, so that every press visibly does something. "Visible" means: for every patch between the heads before and after the press, the JSON of the value at the patch's path (the sequence, for an index path) differs. Compare with keys sorted: a document's key order follows the order of its patches. Note that an empty `diff` is not the criterion: writing an equal value or re-creating an equal object produces patches.
- Not chosen, and why (the proposal should say so): keeping the undos of a run local until the run ends. That needs a fork the tool shows instead of the document; collaborators would keep editing the state being undone away from, and a closed tab would lose the run.

### Inverting a step

A step is a list of the realm's changes. The inverse is computed from their **operations** (`getBackend(d).getDecodedChangeByHash(hash)`; op ids are `${startOp + i}@${actor}`) and written through the low-level backend by object id, inside one `handle.change()`. Patches applied at the change's old heads (`changeAt`) are not enough: concurrent text ends up "tacked unattractively on" ([automerge-repo-undo-redo](https://github.com/onsetsoftware/automerge-repo-undo-redo)'s own README).

Decoded ops carry fields the published `Op` type lacks: `elemId` (for an insert: the element it is inserted after; for a delete or overwrite: the element itself) and `insert`. Classify the step's ops:

| The step's ops | Inverse |
|---|---|
| inserted an element (char or list element) | delete it, if still present |
| deleted an element | insert a copy where it was |
| set or deleted a map key / overwrote a list element (first and last op per key) | restore the value from before the step's first op on it, if the current value is still the step's last; else a conflict |
| incremented a counter | increment by the negative sum |
| anything inside an object the step created | nothing: the object goes with its own inverse |
| `markBegin` / `markEnd` (rich-text marks are sequence elements) | nothing; count as unsupported |
| an element inserted and deleted within the step | nothing |

Rules learned the hard way:

- **Copies get new ids.** Automerge can't undelete; a re-inserted element, a restored value, a restored object are new. Keep a map original id → copy id (also object ids, and inside copied objects: every scalar value's op id and every element id) and follow it (`follow(id)`) whenever the inverse looks for something, as Yjs follows `redone` pointers. Several ids can map to one copy (an element and the value ops that overwrote it); keep the reverse as a multimap.
- **A deletion and its own restore within one step cancel** (an undo and a redo in one run): follow the deleted element's chain; if it reaches an element the step inserted, drop both.
- **Re-insert deleted elements per object in document order**, left to right, each at its tombstone's position. Order two tombstones by resolving the earlier-deleted one at the later deletion's heads: it precedes the other iff its position is ≤ the other's index there.
- **Index inserts land right after the preceding visible element**, so an earlier copy can sit before tombstones its original followed. Before inserting, step back over visible copies whose originals (any of them, breadth-first through the multimap) were visible at the deletion's heads at an index greater than the deleted element's.
- **If the object was itself copied since,** the tombstone isn't in the copy: insert after the nearest earlier element (at the deletion's heads) that has a visible copy.
- **Restores run newest first and repeat in rounds** while one makes another's target reachable (a restored record, then the text inside it).
- **Restoring an overwritten-then-deleted list element** uses the value from before the overwrite; don't restore the value of an element the step inserted (it is deleted anyway).
- **Conflicts:** if someone else set a value after the step (or concurrently, which shows as several values at the key), skip by default, as Yjs's `redoItem` does (`if (left && left.right !== null)` … unless `ignoreRemoteAttributeChanges`); offer `conflict: "force"`. Report skipped paths to the caller.
- **Known consequence, document it:** undo removes the realm's own characters wherever others typed between them, which can leave fragments; undoing the creation of an object deletes others' edits inside it.

### Automerge shortcomings and their workarounds

Write these into the proposal; link upstream issues where they exist.

1. **Cursors only on text** in the JavaScript/wasm API (`"cursors only valid on text"`), though the Rust core supports them on lists. Workaround: identify list elements by the ids of the ops that wrote their values (an element's insert op, unless overwritten), find them by scanning `getAll(obj, i, heads)`, and carry an index between states through `diffPath(obj, from, to)` patches.
2. **A cursor at historical heads throws** (`cursor … is invalid`) for a deleted element with no visible element after it there, once the document has changed since. Workaround: catch it and use `length(obj, heads)`.
3. **Reading heads inside `change()` commits** the pending operations as a change of their own, which the returned document doesn't show ([automerge#1607](https://github.com/automerge/automerge/issues/1607), sibling [#1598](https://github.com/automerge/automerge/issues/1598)). Workaround: take the heads before `handle.change()` and never call `getHeads()` or other committing reads on the backend inside it.

### Keys and focus

- One capturing `keydown` listener per realm, before any tool sees the keys. Mod is Meta on macOS, Ctrl elsewhere (`navigator.platform`, as CodeMirror does). Mod+Shift+Z redoes; Mod+Y redoes outside macOS.
- Which document: the innermost registered element containing the event target; else the one the user used last (track `pointerdown` and `focusin`), because canvases and 3D views often take no focus.
- `<input>`, `<textarea>`, `<select>` and non-CodeMirror `contenteditable` keep the browser's own undo of their text.
- Tools drop their own undo bindings (`history()` / `historyKeymap` in CodeMirror; tldraw's `undo` / `redo` actions overridden to call the service).

## Architecture to work out

The provider protocol (`packages/providers/core`) streams JSON from a provider to a consumer over a `MessagePort`; live `DocHandle`s never cross it (`OverlayRepo` exchanges `DocHandleDescriptor`s for that reason). `<repo-provider>` (registered in `core/patchwork/src/index.ts`) sits above the root view and answers `repo:handle-descriptor` for the whole page.

The engine must run where the tool's handle lives, i.e. in the tool's realm, against the realm-local repo. Propose and implement a split such as:

- **Library, realm-local:** `undoFor(element, handle, options)` returns the shared history for the handle's backing document and registers `element` for the key binding. It is what tools call. It works without any provider (plain automerge-repo apps).
- **Provider, host-level:** a `patchwork:undo` subscription (`{ type: "patchwork:undo", url }`) through which host UI learns `{ canUndo, canRedo }` per document and sends `undo` / `redo` commands. The current protocol only streams provider → consumer; decide whether commands go over the subscription port (the consumer already posts `unsubscribe` on it), a second subscription, or a DOM event, and justify it in the proposal. Mount it where `<repo-provider>` is mounted, so every page has it.
- **Isolation:** find out whether tools can run in separate realms (iframes, workers) today or are planned to, and make sure the design works when the tool's realm is not the frame's.

Check these against the code before committing to them: how `patchwork-view` mounts tools (`core/elements`), how `OverlayHandle` forwards `on("change")` and `doc()`, and whether the overlay's `scopeReplaced` reaches the history.

## Tests

- **Unit (Vitest, two in-memory peers that merge each other's documents).** Give each peer its own actor (`load(save(doc))`; `clone` keeps the actor, which silently breaks "whose changes"). Cover: the scenario below; redo; grouping by time and adjacency; text both peers edit; undoing a deletion around a concurrent insertion (`"<hello world>"` deleted, `"X"` inserted inside concurrently, undo gives `"<helloX world>"`); Delete-key and Backspace runs restored in order; map conflicts under both policies; counters; records shaped like tldraw's (create, move, edit text, delete; undo all; undo the run); deleted-then-restored objects; ignored paths; marks left alone; no-op steps skipped.
- **The collaboration scenario** (Alice and Bob in separate sections): A, B, C, D, E, F alternately; Alice presses undo twice (one step G); Bob H; Alice I; Bob undoes H; Alice presses undo three times, undoing I, then G (bringing back C and E), then E, ending at A C; Bob L. Assert both sections after every action, and that both peers converge.
- **Fuzz with an oracle.** Two peers edit their own sections (text, map values and nested objects, lists with and without element overwrites, records containing text) with random undos, redos, waits and syncs. The oracle per user is a list of snapshots with the run semantics above (including skipping no-op steps). After every action, each section equals the oracle's current state. Pitfalls: don't let the fuzzer write a value equal to the current one (Automerge emits patches for it, the oracle can't see it); compare with sorted keys. Default to a short run in CI; make seeds and steps configurable; run at least 2 × 2000 seeds × 500 actions before declaring done.
- **CodeMirror comparison.** The same scripted transactions, with the same `Transaction.time`, into an `EditorState` with `history()` and into one mirrored into an Automerge document (as automerge-codemirror does) with the service. After every undo and redo, the texts are equal. Sessions: typing with a pause, slow continuous typing, typing at two places, backspace then typing, a paste between typing, replacing a selection, two cursors, a click. Plus the intended difference: an edit after undos keeps them reachable.
- **End-to-end (Playwright, `packages/e2e`, Chromium, Firefox and WebKit if the package supports them).** Two browser profiles syncing through the site's sync server: the collaboration scenario typed in a text tool; undo with the focus in a non-focusable canvas; redo; a form field keeps its own undo; a draft swap resets the history. For tldraw: the same mouse and keyboard actions in a tldraw tool with its own history and with the service give the same shapes after every undo and redo (draw, draw with a pause mid-drag, move, delete).
- **Examples are tests.** Every code example in the proposal and the package README exists as an example tool or test that runs in CI.

## The proposal

Write `docs/proposals/document-undo.md` (create `docs/proposals/` if there is no better established place; check first) in the style of a high-quality PEP: precise, neutral, complete, with numbered sections:

1. **Abstract.**
2. **Motivation:** the costs of per-tool undo (duplication, inconsistency, non-composition, draft swaps, collaborative pitfalls), with concrete examples from editors tools use.
3. **Rationale:** why per-realm-and-document histories; why undo runs are steps (GURQ); why each press is committed at once; why operation-level inversion rather than reverse patches; why skip-on-conflict by default; prior art (Yjs `UndoManager`, Loro's undo with `onPush` / `onPop`, tldraw's marks, CodeMirror's history, Emacs undo).
4. **Specification:** the API (types and semantics of every function and option), the provider selector and messages, key bindings, focus rules, ignored paths, grouping, the inversion table, conflict policy, events (`onApplied(patches)` for tools to move their selection to what changed).
5. **Backwards compatibility:** tools that keep their own history; what happens if both are active; migration steps for CodeMirror and tldraw tools.
6. **Security and privacy implications** (undo only ever writes the realm's own changes' inverses; nothing leaves the realm except through normal sync).
7. **How to teach this:** a five-minute guide for tool authors with the examples.
8. **Reference implementation:** where the code and tests are; measured cost (time per recorded change and per undo for documents of 10 000 and 100 000 characters with long histories).
9. **Automerge limitations and workarounds:** the three above, with upstream links, and what simplifies once they are fixed.
10. **Rejected ideas:** deferred (local) undo runs; reverse patches at old heads; per-tool histories; force-by-default.
11. **Open issues:** restoring selections (Loro's `onPush` / `onPop` cursors), steps spanning several documents, views derived from the document where an undo changes nothing visible (e.g. formatting inside a formula), persistence of histories across reloads.
12. **References.**

## Done when

- The library, provider, helpers, bindings and examples exist with docs; all tests pass, including the long fuzz run once (record the numbers in the pull request).
- The proposal reads as a complete, standalone argument.
- `pnpm` build and typecheck of the workspace pass; a changeset lists the new and changed packages.
