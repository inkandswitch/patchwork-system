# Undo and redo as a service of Patchwork

|                          |                                                  |
| ------------------------ | ------------------------------------------------ |
| Status                   | Draft                                            |
| Type                     | Standards track (tool API, provider protocol)    |
| Created                  | 2026-10-27                                       |
| Reference implementation | `packages/undo` (`@inkandswitch/patchwork-undo`) |

## 1. Abstract

This proposal makes undo and redo of document edits a service of Patchwork.
A tool calls `undoFor(element, handle)` and gets an undo history for the
document it edits: shared with every other tool in the same realm that edits
the document, limited to the realm's own changes, synchronized to
collaborators as ordinary changes, bound to one page-wide set of keys, and
reachable from host UI through a `patchwork:undo` provider. Consecutive undo
and redo presses form a _run_ that the next edit records as a step of its
own, so no state the user has seen becomes unreachable. Undo is computed
from Automerge operations rather than from patches, which keeps
collaborators' concurrent work in place. Helpers integrate CodeMirror and
tldraw; React and Solid bindings sit next to the existing provider bindings.

## 2. Motivation

Undo is a feature nearly every editing tool needs, but it's easy to
get subtly wrong in a collaborative system. Worse, if every tool implements
their own undo logic, the actual outcomes of consecutive undo/redo actions
can differ between editors, making Patchwork feel less coherent and reliable.
Because all documents in Patchwork are Automerge documents and thus have a
recorded history, we have the opportunity to implement this functionality
once as a provider and allow all editors to use it.

In further detail, these are the argument for implementing a central provider:

**Each tool reimplements this functionality.**
A text tool wraps CodeMirror's `history()`;
a canvas tool uses tldraw's `HistoryManager`; most form-based tools have
none at all. Each implementation must separately learn the same lessons:

- _Remote changes must not be undoable._ CodeMirror's history records every
  transaction unless told otherwise; automerge-codemirror has to mark the
  transactions it creates for remote changes with
  `Transaction.addToHistory.of(false)`. A tool that forgets this undoes changes
  of collaborators.
- _A draft swap invalidates the stack._ When an `OverlayHandle` gets a new
  backing (a draft opened or closed), Patchwork emits a `change` with
  `scopeReplaced: true`. A tool's own history still holds inverses computed
  against the previous backing; replaying them against the new document
  corrupts it. Each tool has to notice and reset.
- _Undo state lives in the editor, not in the document._ tldraw's history
  inverts store diffs it recorded itself; when a collaborator moves a shape
  the user then undoes the creation of, the inverse is applied to a record
  that changed under it.
- _Regular undo-stacks destroy past document state, undo-trees are complicated._
  A solution to the GURQ [4] is desirable for UX but not trivial to implement.
  See also [3.2](#32-undo-runs-the-great-undo-redo-quandary).
- _macOS doesn't use Ctrl but Cmd._ This can cause frustration for users on
  whatever OS the tool developer didn't test on.

**Histories don't compose.** A user who edits one document through two
tools (a code pane and a visual editor of the same file, or two panes of
one document) sees one document but two histories: Cmd/Ctrl+Z in either pane
undoes only what went through that pane, in an order that has nothing to
do with the order of the user's edits.

**Behaviour differs per tool.** Ctrl+Y redoes in one tool and does nothing in
another; typing is grouped into words in one and into single characters in
another; an Edit menu in the host can't offer undo at all, because it has
no way to reach a tool's private history.

**Automerge already has the information.** Every change records its actor,
and each realm (see [3](#3-rationale) for an explanation of the term "realm")
loads documents with its own actor, so "the changes made
here" is well defined per realm and per document. An undo can be a new
change that reverts only those changes, leaving everyone else's work alone.
Yjs and Loro ship exactly this as an `UndoManager`: "By default, all local
changes that don't specify a transaction origin will be tracked" (Yjs [1]);
an undo manager "should only undo/redo local operations without affecting
other collaborators' edits" (Loro [2]). Automerge removed its built-in undo
in 1.0 [3], so the place for it is the layer that owns the realm and the
documents: Patchwork.

The benefit is productivity: a tool that writes to its document gets
correct, collaborative, draft-aware undo by calling one function, and its
users get the same keys and the same behaviour everywhere.

## 3. Rationale

**_Glossary note:_** The following text uses the word "realm" multiple times to mean
"an isolated JavaScript environment with its own repo instance", which can be
a browser tab, an iframe or a worker. Right now every tool runs directly in the
page's envionrment, so "realm" is mostly the equivalent to "a tab" in reality.
However, most of the code already anticipates that tools can run in iframes or
workers and many comments in the code already used this term, so we're using
it here as well.

### 3.1 One history per realm and document

A history is keyed by the realm and the backing document. The realm is the
unit that owns an automerge actor: two tabs, two windows, or two realms in one
tab (should tools ever run in iframes or workers) load documents with different
actors and undo independently, as two collaborators would. The document,
not the tool, is the unit of history, so tools on one document compose: an
undo in either pane undoes the user's last step in the document, whichever
pane it was made in.

Tools with multiple editor panes might seem like a purely academical idea, but
they are a useful UX concept for live-coding environments, code-based CAD like
OpenSCAD or executable data analysis tools like Jupyter Notebooks.

The history is keyed by the _backing_ handle, not by the presented URL. A
draft (`OverlayHandle` backed by a clone) and the base document are
different documents with different change histories; undoing a step made in
the draft must not be attempted against the base, and vice versa.

### 3.2 Undo runs: the "great undo-redo quandary"

Linear undo loses the redo branch when the user edits after undoing: the
undone states become unreachable. This is the "great undo-redo quandary"
(GURQ) [4]. Its resolution, also Emacs's [8], is to treat undoing as
editing: consecutive undo and redo presses form a _run_, a pointer that
walks back and forth through the steps. The next edit that isn't an undo or
redo ends the run; if the run ended away from where it started, all its
changes become one new step on top of the history. Undoing that step later
restores what the run undid. Redo exists only inside a run, so the familiar
"undo, undo, redo" behaves as everywhere else, while "undo, undo, type,
undo, undo" brings the undone text back instead of losing it.

### 3.3 Each press is committed at once

Each undo or redo press is applied immediately as a new Automerge change
and syncs like any other. Collaborators see what the user sees; a closed
tab loses nothing; a collaborator who edits during a run edits the state
the user is looking at.

### 3.4 Inversion from operations, not from patches

The inverse of a step is computed from the step's Automerge _operations_
(decoded with `getDecodedChangeByHash`) and written through the low-level
backend by object id, against the current document. The alternative,
recording patches and applying their reverse at the change's old heads
(`changeAt`), is what automerge-repo-undo-redo does [5], and its own README
notes the consequence: concurrent text ends up "tacked unattractively on".
Operations identify elements, so a deletion is restored at the deleted
element's tombstone, between whatever collaborators inserted around it.

### 3.5 Skip on conflict by default

If someone else set a value after the step being undone (or concurrently,
which shows as several values at one key), the inverse leaves the value
alone and reports the path. Overwriting a collaborator's later decision is
more surprising than not undoing a value the user can see was changed by
someone else. This is Yjs's default (`redoItem` gives up when the item was
changed since, unless `ignoreRemoteMapChanges` is set [1]). Tools can ask
for `conflict: "force"`.

### 3.6 Prior art

- **Yjs `UndoManager`** [1]: tracks transactions by origin (local by
  default), groups them by `captureTimeout` (500 ms), scopes to shared types,
  follows `redone` pointers from deleted items to their restored copies.
  This proposal takes the origin rule (as actors), the grouping default, the
  conflict default and the pointer following (`follow(id)`).
- **Loro `UndoManager`** [2]: local-only undo with `mergeInterval`,
  `excludeOriginPrefixes`, and `onPush` / `onPop` callbacks through which
  editors save and restore selections as cursors. [Section 11](#11-open-issues) proposes the
  equivalent for Patchwork.
- **tldraw** [6]: history _marks_ (`markHistoryStoppingPoint`) delimit
  steps; a drag is one step however long it takes. The tldraw helper maps
  marks to `checkpoint()` and disables time-based grouping.
- **CodeMirror `history()`** [7]: groups transactions less than
  `newGroupDelay` (500 ms) apart whose changes are adjacent (`isAdjacent`),
  and ends a group at non-typing user events and selection changes. The
  grouping rules here are CodeMirror's, and a test feeds both the same
  transactions and compares the results.
- **Emacs** [8]: undo is itself an edit that can be undone; the run rule
  here is that idea with a pointer that also redoes.

## 4. Specification

### 4.1 Package

`@inkandswitch/patchwork-undo` (`packages/undo`), with subpaths
`/codemirror` and `/tldraw`. Peer dependencies: `@automerge/automerge`,
`@automerge/automerge-repo`; optional peers for the CodeMirror subpath:
`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`. The
package is in the bootloader's externals, so tools loaded at runtime import
the host's copy through the import map. Realm-wide state lives on
`globalThis` under `Symbol.for("@inkandswitch/patchwork-undo/realm")`, so
tools that bundle their own copy still share one history per document and
one key binding.

### 4.2 API

```ts
function undoFor<T>(
  element: HTMLElement | null,
  handle: DocHandle<T>,
  options?: UndoOptions
): Undo;

type UndoOptions = {
  groupDelayMs?: number; // default 500; Infinity: only checkpoint() splits
  ignore?: (path: Prop[]) => boolean;
  conflict?: "skip" | "force"; // default "skip"
  now?: () => number; // the grouping clock; default Date.now
  restore?: number; // steps rebuilt at a time (4.15); default 10, 0: none
  repo?: { handles: Record<DocumentId, DocHandle<unknown>> }; // default window.repo
};

// What a binding and a history both offer.
interface UndoControls {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(options?: { conflict?: "skip" | "force" }): UndoResult;
  redo(options?: { conflict?: "skip" | "force" }): UndoResult;
  checkpoint(): void;
  subscribe(
    listener: (state: { canUndo: boolean; canRedo: boolean }) => void
  ): () => void;
  onApplied(listener: (event: AppliedEvent) => void): () => void;
  dispose(): void;
}

interface Undo extends UndoControls {
  readonly history: UndoHistory;
}

type UndoResult = {
  applied: boolean; // the press changed the document visibly
  patches: Patch[]; // between the document before and after
  skipped: Array<{ path: Prop[]; reason: "conflict" | "unreachable" }>;
};
type AppliedEvent = UndoResult & { direction: "undo" | "redo" };

function takenByRealm(event: Event | undefined): boolean;

class UndoHistory implements UndoControls {
  constructor(rootHandle: DocHandle<unknown>, options?: UndoHistoryOptions);
  readonly size: number; // number of steps
  reset(): void;
  // ...and the members of UndoControls
}
type UndoHistoryOptions = Omit<UndoOptions, "repo">;
```

- `undoFor` resolves `handle` to its **root backing handle**: an
  `OverlayHandle` is unwrapped (`backingHandle`), and a sub-handle is
  resolved to its root through `options.repo` (sub-handles share their
  root's document, and a `Repo` only hands out root handles, so the root is
  `repo.handles[documentId]`). The engine needs the whole document: its
  actor and its change history.
- It returns a binding to the shared history of that document in the realm,
  creating the history on first use; the history is released with its last
  binding. Bindings contribute their options: ignore predicates are combined
  with OR; the largest `groupDelayMs` among live bindings applies (a tool
  that sets `Infinity` and marks its own boundaries keeps its gestures in
  one step).
- When the handle is an `OverlayHandle` and its backing is swapped
  (`change` with `scopeReplaced: true` and a different root), the binding
  moves to the new backing's history and resets it.
- `element` registers the binding for the key binding ([4.4](#44-key-binding-and-focus)). With `null`, the
  binding has no keys and no provider announcement. Pass the element that
  covers everything the user thinks of as the editor of this document,
  including its toolbars and panels: after a click on a toolbar button,
  focus sits on the button, and Cmd/Ctrl+Z should still undo what it did.
  For a plain text pane that is the editor's element; for a canvas tool with
  a toolbar, the tool's root. Many tools (a canvas, a form) have no single
  element holding the document, so the tool's root is the usual choice.
  Text fields inside it that aren't the document's keep their own undo
  ([4.4](#44-key-binding-and-focus)).
- `subscribe` calls the listener at once and on every change of `canUndo`
  or `canRedo`. `onApplied` fires after every press that did something, with
  whole-document patches, so tools can move their selection to what changed.
- `takenByRealm` says whether the realm's key binding takes `event`, for
  editors whose own shortcut handlers see the press first ([4.4](#44-key-binding-and-focus)).
- `UndoHistory` is the history alone (no keys, no provider), for non-DOM
  use; `undoFor` creates and shares these. `reset()` forgets every step.

### 4.3 Whose changes

A change belongs to the realm if its actor equals the document's actor in
this realm (`Automerge.getActorId(doc)`), compared with
`getChangesMetaSince(doc, lastHeads)[i].actor`. Changes by any other actor
are never recorded and never inverted. Changes made by an undo or redo are
the realm's own and belong to the current run. A new history also rebuilds
steps from the realm's earlier changes, its previous loads' among them
([4.15](#415-restoring-a-history)).

### 4.4 Key binding and focus

One capturing `keydown` listener per realm window, installed by the first
`undoFor` with an element, runs before any tool sees the keys:

| Action | macOS       | Windows, Linux       |
| ------ | ----------- | -------------------- |
| Undo   | Cmd+Z       | Ctrl+Z               |
| Redo   | Cmd+Shift+Z | Ctrl+Shift+Z, Ctrl+Y |

The platform is told from `navigator.platform`, as CodeMirror does (Cmd is
`metaKey` in the event). Alt-modified presses and already-prevented events
are ignored. A capturing `beforeinput` listener handles `historyUndo` /
`historyRedo` (the browser's Edit menu and context menu in editable content)
the same way.

The target history is that of the innermost registered element on the
event's composed path; else that of the element the user used last, tracked
by capturing `pointerdown` and `focusin` (canvases and 3D views often take
no focus). A `pointerdown` or `focusin` outside every registered element
ends the fallback, so a tool that keeps its own history (or the host's
chrome) keeps its keys. If neither exists, the event is left alone. When a binding
handles the event, it calls `preventDefault()` and
`stopImmediatePropagation()`.

The realm's listener is not always first: an editor's own shortcut handler
can see the press before it does (observed with tldraw 5.5, whose shortcuts
run from a listener on the body). `takenByRealm(event)` tells such a handler that the
realm takes this press, so it can leave it alone instead of undoing twice;
the tldraw helper uses it.

`<input>`, `<textarea>`, `<select>` and contenteditable elements keep the
browser's own undo of their text: the registered element is usually a
tool's root, and a filter field, a rename box or a comment draft in it holds
text that isn't the document's. An editor whose edits are the document's is
marked with `data-patchwork-undo` (`UNDO_MARKER`); `undoBoundaries` marks
CodeMirror's content element, and a ProseMirror tool marks its editor
itself. A form field can be marked too, on the field itself: a marker on an
element around it (usually the tool's root) doesn't take its fields. The
marker counts for the editor the key press is in, not for an
editor nested inside it: a comment draft in an embed in the main editor
keeps its own undo.

Tools drop their own undo bindings: `history()` and `historyKeymap` in
CodeMirror; tldraw's `undo` and `redo` actions are overridden ([4.11](#411-editor-helpers)).

### 4.5 Ignored paths

A change whose operations all fall on ignored paths neither forms a step nor
ends a run, and the inverse of any step leaves ignored paths alone; patches
on ignored paths don't count as visible ([4.8](#48-visibility)). Always ignored: top-level
keys starting with `@` (Patchwork metadata such as `@patchwork`, comments in
`@comments`). Tools add their own through `ignore`. The path of an operation
is the path of its object (`objInfo(obj, [hash]).path`) plus its key, for
map operations.

### 4.6 Steps and grouping

A _step_ is a list that groups a realm's changes into undoable units. A new
local change joins the
newest step if all of the following hold, and starts a new step otherwise:

1. no `checkpoint()` was called since the step's last change, and no run
   ended since;
2. it came less than `groupDelayMs` after the step's last change (by the
   history's clock, at the time the change is observed);
3. if it edits text: it touches the step's text range. Ranges are computed
   from the change's patches (`diff(doc, change.deps, [hash])`): for each
   splice or deletion in a text, the index range touched before the change
   and after it. The step keeps the union of its changes' after-ranges,
   mapped through later changes (also collaborators', while the step is
   open). The change touches the step if one of its before-ranges overlaps
   (inclusively) one of the step's ranges, as CodeMirror's `isAdjacent`.

Tools can call `checkpoint()` where they know a boundary to exist, for example before
and after pasting text, or at a word boundary. This can make undoing much more
intuitive.

### 4.7 Runs

Consecutive undo and redo presses form a _run_: `{ start, pointer }` over the
steps, where `start` is the number of steps when the run began.

- **Undo**: while `pointer > 0`, invert step `pointer - 1`, record the
  changes the inversion made as the run's undo of that step, decrement
  `pointer`, and stop if the inversion changed something visibly ([4.8](#48-visibility)).
- **Redo**: while `pointer < start`, invert the changes recorded as the
  run's undo of step `pointer`, increment `pointer`, and stop if visible.
- **End**: the next local change that isn't an undo or redo, and isn't on an
  ignored path, ends the run. If `pointer ≠ start`, all the changes the run
  made become one new step on top of the history; otherwise the run leaves
  no step. The change that ended the run starts a new step.
- `canUndo` is `pointer > 0` in a run, else "there is a step";
  `canRedo` is `pointer < start` in a run, else false.

Collaborators' changes don't end a run.

### 4.8 Visibility

A press is _visible_ if, for some patch between the heads before and after
it (not on an ignored path), the JSON of the value at the patch's path
(the sequence, for an index path) differs between the two states, compared
with object keys sorted (an Automerge document's key order follows the
order of its patches), or, for a text, its formatting (`marks`) differs:
formatting doesn't show in a text's JSON, and a character can be replaced
by an equal one with other formats. An empty `diff` is not the criterion: re-creating an
equal object produces patches. A step whose inverse changes nothing visible
(a character typed and deleted within one step, an equal object written) is
skipped in both directions, so every press visibly does something. A press
that crosses only invisible steps reports `applied: false`.

### 4.9 Inverting a step

**EDITOR's note:** This section is dense, reeks of barely comprehensible LLM-
speak and mostly duplicates the behavior of the code. Consider rewriting it.

The step's operations are decoded (`getBackend(doc).getDecodedChangeByHash`;
op ids are `${startOp + i}@${actor}`). Decoded operations carry `elemId`
(for an insertion, the element it is inserted after; for a deletion or an
overwrite, the element itself) and `insert`, which the published `Op` type
lacks. They are classified:

| The step's operations                                                                               | Inverse                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| inserted an element (character or list element)                                                     | delete it, if still present                                                                                                    |
| deleted an element                                                                                  | insert a copy where it was                                                                                                     |
| set or deleted a map key, or overwrote a list element (first and last operation per key or element) | restore the value from before the step's first operation on it, if the current value is still the step's last; else a conflict |
| incremented a counter                                                                               | increment by the negative sum                                                                                                  |
| anything inside an object the step created                                                          | nothing: the object goes with its own inverse                                                                                  |
| `markBegin` / `markEnd` (a format set or removed over a range)                                      | restore each part of the range to the format it had before; a conflict where the format changed since                          |
| an element inserted and deleted within the step                                                     | nothing                                                                                                                        |
| an operation on an ignored path                                                                     | nothing                                                                                                                        |

Copies get new ids: Automerge can't undelete. A map from every original id
to its copy is kept per history, covering elements, value operations,
objects, and, inside copied objects, every scalar value's operation and
every element; `follow(id)` follows it (copies of copies included) whenever
the inverse looks something up. Several ids can map to one copy (an element
and the value operations that overwrote it), so the reverse is a multimap.

The inverse is executed in rounds, each in this order:

1. **Restores** (map keys, overwritten list elements), newest first. A
   restored value that was an object is deep-copied from the state before
   the step. An overwritten-then-deleted list element is restored, by the
   reinsertion below, with the value from before the overwrite; the value of
   an element the step inserted is not restored (it is deleted anyway).
2. **Deletions** of the elements the step inserted. They run before the
   reinsertions because they find their elements by id; once gone, the
   copies they were don't stand between a tombstone and its place.
3. **Reinsertions**, per object in document order, left to right, each at
   its tombstone's position. Two tombstones are ordered by resolving the
   earlier-deleted one at the later deletion's heads: it precedes the other
   iff its position there is ≤ the other's index. The position is the
   number of visible elements before the tombstone: by cursor in a text; in
   a list, by carrying the element's index from its deletion through
   `diffPath` patches, which come in document order (until the element's
   own deletion goes by, an insertion at its index shifts it; after, it
   doesn't).
   - An index insertion lands right after the preceding visible element, so
     an earlier copy can sit before tombstones its original followed. Before
     inserting, the position steps back over visible copies that existed at
     the deletion's heads after the deleted element, or whose nearest
     original did (resolved by cursor in a text, which also places
     tombstones).
   - If the object itself was copied since, the tombstone isn't in the
     copy: the element goes after the nearest earlier element (at the
     deletion's heads) that has a visible copy, and after the copies this
     inverse already reinserted there.
4. **Counter increments.**

After the rounds, re-inserted characters get the formats they had before
the step (where they were deleted, or, if the step formatted their text
before deleting them, where the step began): a copy is a new element and
carries no formatting. One `mark` or `unmark` covers each run of adjacent
characters missing the same value. Copied texts take their source's
formatting along.

Then the step's formatting is undone, newest first. Each change's `mark`
patches give the ranges it formatted; the patches of a change apply one
after another, so a range is mapped back through the text splices before
it (characters the change inserted drop out, the inverse removes them).
The range is split where the format had different values before the
change, and each piece gets its old value back (`mark`, or `unmark` where
there was none), using the `expand` of the step's own mark. The ends of a
piece are found by element, or by their tombstones if gone; characters
this inverse re-inserted are left out, they have their own formats back.
If the format no longer has the step's value over a piece, someone else
changed it since: a conflict, under the conflict policy ([4.10](#410-conflict-policy)).

A round runs every action whose target object (followed) is reachable; the
rounds repeat while one makes another's target reachable (a restored
record, then the text inside it). Actions still unreachable are reported as
skipped.

A deletion and its own restore within one step cancel (an undo and a redo
in one run): the deleted element's copy chain reaches an element the step
inserted and didn't delete again; both are dropped, and if the element's
value changed within the step, that value is restored on the copy.

**Known consequences.** Undo removes the realm's own characters wherever
others typed between them, which can leave fragments of a word around a
collaborator's insertion. Undoing the creation of an object deletes others'
edits inside it. Both follow from undoing only one's own operations.

### 4.10 Conflict policy

With `conflict: "skip"` (default), a restore whose target's current value is
not the step's last value (someone else set it since, or a concurrent value
shows as a second value at the key) is skipped and reported as
`{ path, reason: "conflict" }`. Formatting is handled the same way: if the
format no longer has the step's value over a range (someone else bolded or
unbolded it since), that range is skipped and reported with the text's
path. With `"force"`, the old value is restored anyway. The policy is set per history (`UndoOptions.conflict`) and per
press (`undo({ conflict })`).

### 4.11 Editor helpers

The service sees only changes to the document. It can't know
where one of the user's actions ends and the next begins beyond what time
and text positions tell it ([4.6](#46-steps-and-grouping)), so a paste right after typing, or a
drag that pauses, would land in the wrong steps. Editors that bring their
own undo history know these boundaries: CodeMirror knows which edit was a
paste and when the user clicked elsewhere, and tldraw marks the start of
every gesture. These editors also have undo built in, through their own
key shortcuts, menu items and toolbar buttons, which would bypass the
service. A helper connects such an editor to the service: it passes the
editor's boundaries on as `checkpoint()` calls. For tldraw it also points
the editor's undo commands at the service; a CodeMirror tool simply drops
CodeMirror's history, and the realm's key binding takes the keys.

Authors of tools built on CodeMirror, ProseMirror or tldraw add the
helpers once, where they set up the editor, next to their `undoFor` call
([Section 5](#5-backwards-compatibility) lists the steps). Users never see them: they get the same steps
the editor's own history would make, and the same undo from the keys, the
editor's menus and the host's Edit menu. Tools without such an editor (a
form, a canvas drawn by the tool itself) need no helper; they call
`checkpoint()` themselves where they know a boundary ([Section 7](#7-how-to-teach-this)).

The rest of this section specifies what the helpers do.

`@inkandswitch/patchwork-undo/codemirror`:

- `undoBoundaries(undo): Extension` calls `checkpoint()` from an
  `EditorState.transactionExtender` (which runs before automerge-codemirror
  writes the change; an update listener runs too late) before a user
  transaction that changes the document and isn't typing or deleting
  (`!tr.isUserEvent("input.type") && !tr.isUserEvent("delete")`, e.g. a
  paste), on a selection-only user transaction (`tr.isUserEvent("select")`),
  and around transactions annotated with `isolateHistory`. Transactions
  without a user event (remote changes) are ignored. It also marks the
  editor's content element with `data-patchwork-undo`, so the key binding
  takes this editor's keys ([4.4](#44-key-binding-and-focus)); CodeMirror editors without it, such as
  comment drafts and chat inputs, keep their own undo.
- `followUndo(view, undo, path)` moves the cursor to the end of the last
  change an undo or redo made to the text at `path`.

`@inkandswitch/patchwork-undo/prosemirror`:

- `undoBoundaries(undo): Plugin` replaces `prosemirror-history` and its
  undo keymap. It marks the editor with `data-patchwork-undo` (through the
  plugin's `attributes` prop), so the key binding and the browser's Edit
  menu send Cmd/Ctrl+Z in the editor to the service. It ends a step at a
  transaction marked with `prosemirror-history`'s `closeHistory(tr)` (by
  that function's meta key, `closeHistory$`; pinned and tested against
  prosemirror-history 1.5), so tools keep calling it. It does so in
  `filterTransaction`, which runs before `@automerge/prosemirror` writes
  the transaction to the document in `appendTransaction`. Unlike
  CodeMirror's history, `prosemirror-history` treats neither pastes nor
  selection changes as boundaries, and neither does the helper.
- Rich text's block markers (paragraphs, headings: objects inside the
  text) take part in adjacency like characters, and a deleted block marker
  is restored the way `splitBlock` creates one, so bindings see a block.
  Formatting (bold, emphasis, links) is undone with the text
  ([4.9](#49-inverting-a-step)), so undoing Cmd+B removes the bold.
- `@automerge/prosemirror` 0.2.0 mistranslates a remote deletion that
  spans block markers into the editor, so the view can drift from the
  document. A collaborator's edit triggers it as much as an undo; the
  document itself is correct. A test pins the bug, to notice its fix.
- The ProseMirror packages aren't in the host's import map, so tools bundle
  this subpath with their own ProseMirror; histories are still shared,
  since the realm's state is global.

`@inkandswitch/patchwork-codemirror` (not yet implemented, location TBD):

- `patchworkText` extension for CodeMirror's `EditorView`. Wraps
  `automergeSyncPlugin` and provides full integration with Patchwork's undo
  service using the helpers from `@inkandswitch/patchwork-undo/codemirror`.
  The goal is to make it as easy as possible for tool authors to write
  correctly integrated text editors. This could be expanded in the future
  to integrate presence and comments so tool authors don't have to implement
  those integrations themselves either.

`@inkandswitch/patchwork-undo/tldraw`:

- `tldrawOptions(storePath = ["store"])`: `groupDelayMs: Infinity` and
  `ignore: tldrawIgnore(storePath)`, which ignores tldraw's `user:…` record:
  tldraw re-creates it immediately whenever an undo deletes it, and unless
  ignored, that re-creation ends every run and redo never works.
- `bindTldraw(editor, undo)` wraps `editor.history._mark(id)` (all marks go
  through it; internal to tldraw, pinned and tested against
  `@tldraw/editor` 5.5) to call `checkpoint()`, and routes `editor.undo`,
  `redo`, `canUndo`, `canRedo` to the service. tldraw keeps recording its own
  history, so `bailToMark` and `squashToMark` still work. tldraw delivers
  store changes to listeners (and so to a binding writing them to the
  document) batched on the next frame, after the mark that should separate
  them; the helper flushes the store (`store._flushHistory()`, also
  internal) before every checkpoint, undo and redo.
- `tldrawOverrides(undo)` for `<Tldraw overrides>`: the `undo` and `redo`
  actions (menus, toolbar, their shortcuts) call the service, except for a
  press the realm's key binding takes (`takenByRealm`, [4.4](#44-key-binding-and-focus)).
- tldraw's own history also holds steps that only change the selection
  (session state, which is not in the document). The service has nothing to
  undo there; its steps are the document's.

### 4.12 Framework bindings

`@inkandswitch/patchwork-providers-react`: `useUndo(element, handle,
options)` returns `{ canUndo, canRedo, binding }` (or `undefined` until both
are there); `useUndoStatus(element, url?)` returns the provider's status
plus `undo()` and `redo()`. `@inkandswitch/patchwork-providers-solid`:
`createUndo(element, handle, options)` returns accessors and commands;
`undoStatus(element, url?)` the status accessor and commands.

### 4.13 Provider protocol

The provider protocol (`@inkandswitch/patchwork-providers`) streams JSON
from a provider to a consumer over a `MessagePort`. This proposal adds a
way back: `connect(element, selector, listener)` returns
`{ send(command), close() }`; `send` posts `{ type: "command", value }` on
the subscription's own port, and the answering provider receives it through
`onCommand` in the context its `accept` producer now gets as a second
argument. `subscribe` is `connect(...).close`, unchanged for existing
callers.

Two selectors:

- **`{ type: "patchwork:undo", url? }`**, for host UI. The provider answers
  with `UndoStatus = { url: string | null; canUndo: boolean; canRedo:
boolean }` whenever it changes, for the history of the document at `url`
  (presented or backing), or, without `url`, the history the user used last.
  The consumer sends the commands `"undo"` and `"redo"`.
  `watchUndo(element, url, listener)` wraps this as
  `{ undo(), redo(), close() }`.
- **`{ type: "patchwork:undo-source", url, backing }`**, internal: each
  binding with an element announces its history this way, with the
  presented and the backing document. It sends
  `{ canUndo, canRedo, active }` (`active`: when the user last used its
  element, in epoch ms); the provider answers with
  `{ command: "undo" | "redo" }`.

The provider, `<undo-provider>` (or `installUndoProvider(element)`), never
touches a history. It keeps the announced sources, picks the one for a
`url` (most recently active first), and forwards commands to it. Patchwork's
`setup()` registers the element and mounts it where it mounts
`<repo-provider>`, and generated site HTML declares it: `<repo-provider>
<undo-provider><patchwork-view id="root">`.

**Why commands go over the subscription port.** Three options were weighed:

1. _Commands on the subscription's port_ (chosen). The port already exists,
   already carries a message from consumer to provider (`unsubscribe`), is
   scoped to exactly the provider that answered, and is transferable: it
   works wherever the subscription reached, including another realm. Its
   lifetime is the subscription's, so commands can't outlive their target.
2. _A second subscription_ for commands would need correlating with the
   first and double the bookkeeping, for no gain.
3. _A DOM event_ for commands would need the host to know which element to
   dispatch it on (it doesn't: the history lives under some tool's element),
   and would not cross realms.

### 4.14 Realms and isolation

Tools run today in the page's realm, mounted by `<patchwork-view>`. The code
anticipates embedded realms: `OverlayRepo` remaps "across provider scopes
(including iframes)", the module watcher handles `srcdoc` frames, and
`LegacyImpl` loads a suggested module "in this element's own realm … so a
`<patchwork-view>` nested in an embedded context (e.g. an iframe an event
couldn't bubble out of) still resolves its own tool". The design holds for
a tool whose realm is not the frame's:

- The engine runs where the tool's handle lives: in the tool's realm,
  against the realm-local repo; it never needs a live handle from elsewhere.
- The key binding is per realm window; keys pressed in an iframe reach that
  iframe's listener.
- The host reaches histories only through `MessagePort`s announced by the
  realm (`patchwork:undo-source`). Wherever a bridge carries
  `patchwork:subscribe` from an embedded realm to the host, as `OverlayRepo`
  already requires for `repo:handle-descriptor`, the undo provider works
  unchanged.

### 4.15 Restoring a history

Histories live in memory, and every load of a document gets a new actor. A
new history therefore rebuilds steps from the changes already in the
document that are the realm's: those of the document's actor (a history
created again after the last tool closed), and those of every actor with
the document's Automerge `author` (`getActorsForAuthor(doc,
getAuthor(doc))`: earlier loads). Every Repo Patchwork builds sets `author`
to its signer's verifying key (`patchwork.signer.verifyingKey`, hex), so
the earlier loads are this browser profile's. Automerge records the author
in an actor's first change only; the Repo sets it on every document before
that change.

- **Lazily.** The newest `restore` steps (default 10; `0` turns restoring
  off) are rebuilt when the history is created, and the next `restore` when
  an undo reaches the oldest rebuilt step. The undo that reaches it goes on
  into them, and a run's `start` and `pointer` move up by the steps added
  below. Finding the realm's changes reads every change's metadata once
  (`getChangesMetaSince(doc, [])`); only the rebuilt steps' changes are
  decoded.
- **Grouping.** A change keeps no checkpoints, millisecond times or text
  ranges, so [4.6](#46-steps-and-grouping) can't be replayed: consecutive
  changes of one actor at most one second apart (Automerge's `time` is in
  whole seconds) join one step. Changes only to ignored paths are left out.
- **Runs.** The change an undo or redo press makes carries the message
  `patchwork-undo` (`PRESS_MESSAGE`). Consecutive press changes of one actor
  form one step, as the run did when it ended ([4.7](#47-runs)). A run that
  ended where it started left no step; rebuilt, its step is invisible and
  skipped ([4.8](#48-visibility)).
- **Not rebuilt:** a document's first change (`Repo.create` with an initial
  value) and a change that sets `@patchwork` (`patchwork.create`, which runs
  the datatype's `init`): undoing them would take away the structure tools
  expect.
- **Positions.** The inverse compares changes by their position in the
  realm's chain ([Section 9](#9-automerge-limitations-and-workarounds),
  item 2). A rebuilt history spans several actors, whose `seq` count each
  actor's changes separately, so a change's position is its index in the
  document's change order (`InverseContext.positions`); changes recorded
  later continue from the number of changes there were.

## 5. Backwards compatibility

The change is additive. `accept` producers get a second argument, which
existing producers ignore; `subscribe` keeps its signature and behaviour.

**Tools that keep their own history** keep working. If such a tool also
calls `undoFor` (or another tool on the same document in the same realm
does), both react to Cmd/Ctrl+Z: the realm's listener runs first, during
capture, and stops propagation, so the tool's own keymap never sees the
event while the event target is inside a registered element. A tool that
doesn't call `undoFor` and isn't nested in one that does is unaffected.
Mixing both on one document is not recommended: the tool's history would
replay inverses computed before the service's undo.

**Migrating a CodeMirror tool:**

1. Remove `history()` and `historyKeymap` from the extensions.
2. `const undo = undoFor(element, handle)`.
3. Add `undoBoundaries(undo)`; optionally `followUndo(view, undo, path)`.
4. `undo.dispose()` on teardown.

**Migrating a ProseMirror tool:**

1. Remove `history()` and its undo keymap from the plugins.
2. `const undo = undoFor(element, handle)`.
3. Add `undoBoundaries(undo)` from `@inkandswitch/patchwork-undo/prosemirror`;
   keep calling `closeHistory(tr)` where the tool did.
4. `undo.dispose()` on teardown.

**Migrating a tldraw tool:**

1. `const undo = undoFor(element, handle, tldrawOptions(storePath))`.
2. `onMount={(editor) => bindTldraw(editor, undo)}` and
   `overrides={tldrawOverrides(undo)}`.
3. `undo.dispose()` on teardown.

## 6. Security and privacy implications

Undo only ever writes inverses of the realm's own changes, through the same
`handle.change()` any tool uses; it gains no capability a tool doesn't have.
It never reads or writes other documents. Nothing leaves the realm except
through normal sync: the provider messages carry document URLs and the
booleans `canUndo` / `canRedo` and a timestamp of the user's last use, to
the host page, which already knows the URLs. Histories are not persisted;
they are rebuilt from the document ([4.15](#415-restoring-a-history)).

Every change records its signer's verifying key as its actor's `author`
([4.15](#415-restoring-a-history)). The key is public, but it stays in
each document's history for good and links the changes one browser profile
makes across all documents it edits.

## 7. How to teach this

_For tool authors, five minutes._

A tool that changes its document gets undo by asking for it with the element
that covers its editor, toolbars included (usually the element it renders
into):

```js
import { undoFor } from "@inkandswitch/patchwork-undo";

export function mountCanvas(handle, element) {
  const undo = undoFor(element, handle);
  canvas.addEventListener("pointerdown", (event) => {
    handle.change((doc) => {
      doc.dots ??= [];
      doc.dots.push({
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    });
    // Each click is a step of its own.
    undo.checkpoint();
  });
  return () => undo.dispose();
}
```

That's it: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z work while the user is in the tool, or
used it last; collaborators' changes are left alone; a second tool on the
same document shares the history; a draft swap resets it.

Four things to know:

1. **Steps.** Changes less than half a second apart form one step (typing
   words, not letters). Call `undo.checkpoint()` where your tool knows a
   boundary: a click, a finished gesture, leaving a field.
2. **Editors.** For CodeMirror or ProseMirror, replace `history()` with
   `undoBoundaries(undo)` from the matching subpath. For tldraw, pass `tldrawOptions()` and call
   `bindTldraw(editor, undo)`.
3. **State.** `undo.subscribe(({ canUndo, canRedo }) => …)` for your own
   buttons; host UI uses `watchUndo(element, url, listener)` and needs no
   access to your tool.
4. **Text.** Put the document's text in CodeMirror (or ProseMirror for rich
   text), not a `<textarea>`: a textarea can only be set as a whole, which
   moves the caret and loses the browser's undo whenever a collaborator's
   edit arrives. Plain `<input>`s are fine for short fields such as a title;
   inside them, Cmd/Ctrl+Z stays the browser's. A ProseMirror editor (or any
   other contenteditable) that writes to the document needs the
   `data-patchwork-undo` attribute, which `undoBoundaries` sets for you, in
   CodeMirror and in ProseMirror.

The complete examples (a text tool, a canvas tool, a form tool, and an Edit
menu) are in `packages/undo/examples/` and run in the test suite.

## 8. Reference implementation

- Engine: `packages/undo/src/history.ts` (recording, grouping, runs,
  visibility), `invert.ts` (classification and inversion), `copies.ts`
  (the copy map), `ranges.ts` (text adjacency), `visible.ts`.
- Realm layer: `realm.ts` (`undoFor`, keys, focus, source announcement),
  `handles.ts` (root resolution), `provider.ts` and `protocol.ts`
  (`patchwork:undo`).
- Helpers: `codemirror.ts`, `tldraw.ts`; bindings in
  `packages/providers/frameworks/{react,solid}`.
- Host: `core/patchwork/src/index.ts` and `site-kit/html.ts` mount
  `<undo-provider>`; `core/bootloader/src/externals-list.ts` shares the
  package through the import map.
- Author: `patches/@automerge__automerge-repo@2.6.0-subduction.48.patch`
  adds `RepoConfig.author`; `core/patchwork/src/repo.ts` and
  `core/bootloader/src/automerge-protocol-handler.ts` pass the signer's key
  (`signerIdentity` in `core/bootloader/src/signer.ts`), tested in
  `core/patchwork/test/author.test.ts`.
- Tests (`packages/undo/test`):
  - `history.test.ts`: the collaboration scenario below, redo, grouping by
    time and adjacency, text both peers edit, a deletion around a
    concurrent insertion (`"<hello world>"` deleted, `"X"` inserted inside
    concurrently, undo gives `"<helloX world>"`), Delete-key and Backspace
    runs, map conflicts under both policies, counters, tldraw-shaped
    records, deleted-then-restored objects, ignored paths, marks, skipped
    no-op steps;
  - `fuzz.test.ts`: two peers edit their own sections (text, map values and
    nested objects, lists with and without element overwrites, records
    containing text) with random undos, redos, waits and syncs, against a
    snapshot oracle per user with the run semantics; and a shared-section
    variant checking that nothing throws and the peers converge;
  - `codemirror.test.ts`: the same transactions into CodeMirror's history
    and into the service; equal after every undo and redo, in eight
    sessions, plus the intended difference;
  - `prosemirror.test.ts`: the same transactions into ProseMirror with
    `prosemirror-history` and into an editor synced by
    `@automerge/prosemirror` with the service; equal after every undo and
    redo, in eight sessions (paragraph splits and joins among them);
  - `tldraw.test.ts`: the same interactions on a tldraw editor with its
    own history and on one bound to the service, through a store mirror;
  - `restore.test.ts`: steps rebuilt from a previous load with the same
    author and from the history's own actor, another author's changes left
    alone, grouping by time, a previous load's run kept in one step, older
    steps rebuilt once undo reaches them, and the document's creation not
    rebuilt;
  - `realm.test.ts`, `examples.test.ts`: keys, focus, form fields, sub-
    handles, draft swaps, the provider, and the example tools;
  - `packages/e2e/tests/undo.spec.ts` (Playwright): the collaboration
    scenario typed by two browser profiles syncing through the sync server;
    undo and redo with the focus outside a canvas; a form field keeping its
    own undo; the Edit menu and a draft swap resetting the history; and the
    same mouse and keyboard actions (draw, draw with a pause mid-drag, move,
    delete) in a tldraw editor with its own history and in one bound to the
    service, giving the same shapes after every undo and redo.

**The collaboration scenario.** Alice and Bob edit separate sections of one
document. Each letter is one step; after every action both peers see the
same document.

| Action                                | Alice's section | Bob's section |
| ------------------------------------- | --------------- | ------------- |
| Alice types A                         | A               |               |
| Bob types B                           | A               | B             |
| Alice types C                         | AC              | B             |
| Bob types D                           | A               | BD            |
| Alice types E                         | ACE             | BD            |
| Bob types F                           | ACE             | BDF           |
| Alice undoes twice (E, then C)        | A               | BDF           |
| Bob types H                           | A               | BDFH          |
| Alice types I: her run becomes step G | AI              | BDFH          |
| Bob undoes H                          | AI              | BDF           |
| Alice undoes I                        | A               | BDF           |
| Alice undoes G, bringing back C and E | ACE             | BDF           |
| Alice undoes E                        | AC              | BDF           |
| Bob types L                           | AC              | BDFL          |

**Fuzzing.** 2 × 2 000 seeds × 500 actions against the oracle (seeds
1–2 000 and 2 001–4 000), with formatting (bold, italic and links set and
removed over random ranges, compared as part of each snapshot), pass in
about 27 minutes each; so do 2 × 667 seeds × 500 actions on a shared
section (no throws, the peers converge). The fuzzer found the inversion's
bugs while it was being written: cancel rules within runs, list positions
next to tombstones, reinsertion into copied objects, the step-back rule,
the order of removals and reinsertions, and, for formatting, ranges in a
change's sequential patch coordinates, formats of re-inserted characters,
and several formatting operations within one change.
CI runs 30 + 10 seeds × 150 actions.

**Cost**, measured with `BENCH=1 vitest run test/bench.test.ts` (Node 24,
Apple silicon; the document typed in changes of 10 characters, so the
history is as long as the text; "recorded" is a one-character change with
a history attached, including recording it):

| Characters | A change, no history | A change, recorded | Undo a typed step | Undo a 1 000-character deletion | Redo it |
| ---------- | -------------------- | ------------------ | ----------------- | ------------------------------- | ------- |
| 10 000     | 0.08 ms              | 0.11 ms            | 2.3 ms            | 132 ms                          | 67 ms   |
| 100 000    | 0.07 ms              | 0.11 ms            | 16.5 ms           | 175 ms                          | 80 ms   |

Recording costs one `getDecodedChangeByHash` and one single-change `diff`
per local change: a few hundredths of a millisecond. Undoing a step costs
decoding its operations, a few lookups at old heads per contiguous run of
deleted text ([Section 9](#9-automerge-limitations-and-workarounds), item 5), and current-state lookups per element. Lists have no
run shortcut yet: restoring k deleted list elements costs k scans of the
list at old heads.

## 9. Automerge limitations and workarounds

1. **Cursors only on text** in the JavaScript/wasm API: `getCursor` on a
   list fails with "cursors only valid on text", though the Rust core
   supports cursors on lists. _Workaround:_ list elements are identified by
   the ids of the operations that wrote their values (an element's insert
   operation, unless overwritten; every value this realm wrote into an
   element is remembered), found by scanning `getAll(obj, i, heads)`, and an
   index is carried between states through `diffPath(obj, from, to)`
   patches. _Once fixed:_ list positions become cursor lookups like text,
   and the index carrying and value-id bookkeeping go away.
2. **A cursor at historical heads stops resolving once the document
   changes.** For an element that is deleted at `heads` and has nothing
   visible after it there, `getCursorPosition(obj, cursor, heads)` returns
   the right position (the length at `heads`) until the document gets
   another change. From then on it throws `cursor … is invalid` for the
   same `heads`. An element that didn't exist yet at `heads` throws the
   same error, deliberately, so a caller can't simply treat the error as
   "at the end". _Workaround:_ the engine first checks elements the realm
   created against the heads (the realm's changes form a chain by position
   ([4.15](#415-restoring-a-history)), so an element exists at the heads
   of a later own change iff its change's position is lower), then catches
   the error and uses `length(obj, heads)`. _Once fixed_ (a fix exists but
   is not yet submitted upstream), the error means only "didn't exist yet",
   and the check against the realm's own elements goes away.
3. **Reading heads inside `change()` commits** the pending operations as a
   change of their own, which the returned document doesn't show
   (automerge#1607 [9]; sibling automerge#1598 [10]). The same holds for
   `diffPath`. _Workaround:_ everything that reads at historical heads, and
   the heads themselves, is read before `handle.change()`; inside it, only
   reads of the current state (`getAll`, `getCursorPosition` without heads,
   `objInfo`) are used. _Once fixed:_ the plan/execute split can collapse.
4. **A cursor naming another object's element panics** in the Rust core
   (`assertion failed: obj_range.contains(&pos)`), which aborts the wasm
   module, rather than throwing an error (automerge#1593 [12]; fixed on
   Automerge's `main`, not yet in a release). _Workaround:_ the engine
   records which sequence every element and copy lives in and only asks a
   cursor position of the object an element belongs to. _Once fixed_ in a
   release, such a lookup throws `cursor … is invalid` and can be caught
   like the others; the record then only saves the failed lookups.
5. **Reads at historical heads cost as much as reading the whole object
   there.** On a 10 000-character text, `getCursorPosition` at old heads
   takes about 11 ms and `getAll` about 6 ms, against about 0.01 ms for the
   current state. One lookup per deleted character made undoing a
   1 000-character deletion take minutes. _Workaround:_ the delete ops of one
   change whose tombstones now share a position, and are consecutive, are one
   contiguous deletion: two lookups (its first and last element) place the
   whole run, and the characters come from one read of the text at those
   heads; the per-element lookup remains the fallback. This assumes such a
   run's ops are in document order (as a splice makes them) or its reverse
   (as the inverse's own removals, which run right to left, make them); a
   change that deletes adjacent characters in another order (two splices of
   adjacent ranges, the later one first) can restore them out of order. Reinsertions skip the
   lookup for copies the same inverse made. _Once fixed_ (an index at old
   heads, or a batch "ids of this sequence at these heads"), the run
   heuristic goes away.

**The author is lost on load.** `A.load(bytes, { author })` ignores
`author`, and `loadIncremental` into an empty document drops the one it
had, which is how automerge-repo opens a document from storage or sync.
_Workaround:_ the Repo sets its `author` again after every mutation
(`patches/@automerge__automerge-repo@2.6.0-subduction.48.patch`).

**Formatting read from a historical view is the current formatting.**
`A.marks(A.view(doc, heads), path)` returns the formatting as it is now, not
as it was at `heads`: the wrapper in `@automerge/automerge`
(`javascript/src/implementation.ts`) calls the wasm `Automerge.marks`
without the view's heads, unlike `A.spans` and `A.getCursor`, which pass
them (automerge#1653 [11]). The wasm function itself
(`rust/automerge-wasm/src/lib.rs`) takes optional heads and reads the
formatting at them correctly. _Workaround:_
the engine calls the wasm function directly, as
`A.getBackend(doc).marks(obj, heads)`. _Once fixed_ (the wrapper passes
`state.heads`), the engine can use `A.marks` on a view.

Writing an equal scalar value is a no-op in Automerge 3.5 (no operation),
while re-creating an equal object produces operations and patches; the visibility rule of
[4.8](#48-visibility) covers both.

## 10. Rejected ideas

- **Deferred (local) undo runs.** Keeping a run's undos local until the run
  ends, and committing only the net result, would avoid syncing
  intermediate states. It needs a fork the tool shows instead of the
  document; collaborators would keep editing the state being undone, increasing
  the likelyhood of unnecessary conflicts. If a tab is closed quickly before the
  run was commited, its changes would be completely lost.
- **Reverse patches at old heads.** Recording patches and applying their
  reverse with `changeAt(oldHeads)` places restored text by index at the
  old state, so concurrent insertions end up next to, rather than inside,
  restored text [5]. Operations name elements; tombstones keep their place.
- **Per-tool histories.** Simple to build, but they don't compose across
  tools on one document, can't be reached by host UI, and make every tool
  relearn the collaborative pitfalls ([Section 2](#2-motivation)).
- **Force by default.** Restoring values someone else changed since would
  silently overwrite collaborators' later decisions.

## 11. Open issues

- **Frame tools with several panes.** The tiling frame tool mounts every
  panel as a `<patchwork-view>` in the tab, without iframes, so all panels
  share one realm. Each panel wraps its tool in a draft state and draft
  overlay provider, so each tool gets its own `OverlayHandle`. Without an
  open draft, panels on one document are backed by the same handle and so
  share one history. Drafts are scoped per panel: a panel that opens one
  moves to the draft's history, and the other panels stay on the base
  document's. Keys go to the innermost registered element, so to the
  focused panel's document, or to an embedded document's own tool if that
  tool registers a binding; panels that take no focus (a 3D view) get the
  keys once used. An Edit menu in the frame's top bar would use
  `watchUndo` without a url and follow the panel used last. Not yet done:
  the frame tool's tools (the text editor with its own `automergeHistory`,
  the CAD tool with its own undo) still keep their own histories until they
  move to `undoFor`; and two real panels on one document (shared steps, keys
  moving between panels and embeds) are untested beyond the realm tests in
  happy-dom. Frame tools that mount tools in iframes instead (such as
  `patchwork-base`'s isolation component) give each pane its own realm and
  history, and reach the host's provider only through a bridge
  ([4.14](#414-realms-and-isolation)).
- **Restoring selections.** Loro's `onPush` / `onPop` let an editor store a
  selection (as cursors) with each step and restore it on undo [2]. The
  service only reports patches (`onApplied`), from which `followUndo` puts
  a caret at the change. Storing per-step metadata from tools would allow
  exact selection restore.
- **Steps spanning several documents.** A gesture that edits two documents
  (moving a card between boards) becomes two steps in two histories.
  An undo in one document would remove the new card but not restore it in
  the other. Cross-document steps would need shared runs across histories.
  It is currently unclear how that would be resolved at all, but it's
  a decent argument for making this functionality part of patchwork itself
  and resolve it there instead of putting this burden on every tool-author.
- **Derived views.** A tool that renders a view derived from the document
  can see "nothing visible" where the document did change (e.g. if a document
  contains a formula and a tool only shows a formatted version of that formula,
  a whitespace change inside the document might not be visible in the UI);
  visibility is judged on the document's JSON, so such a press is not skipped,
  and the user sees no effect. This likely has to be resolved by each tool-
  author; we cannot judge which change is user-visible from inside the framework.
- **Restored histories** ([4.15](#415-restoring-a-history)) have limits:
  - The scope is the browser profile, not the tab: every tab on an origin
    shares one signer, so a restored history holds what all of them did,
    including another tab open at the same time. Two such tabs' changes
    don't form a chain, which the inverse's positions assume.
  - Their steps are grouped by time alone, so they can differ from the
    steps the earlier load had.
  - What the inverse remembers across steps (copies of restored objects,
    every value written into a list element) is rebuilt only from the
    rebuilt steps' changes, not from older ones or from the earlier load's
    copies.
  - Changes made before Patchwork set `author` have none and can't be
    restored.
  - `author` is self-asserted: any peer can write any key. For undo this
    only lets someone make their own changes undoable by you.
  - Which user a signer belongs to is not recorded anywhere. Attributing
    changes to users (such as the history view's [author icons, today the
    first two hex characters of each change's actor
    ID](https://github.com/inkandswitch/patchwork-pkg-base/blob/8548485fb23e4b2b029b6795e81bc94bfa6e896a/history-view/src/history/components/HistoryItem.tsx#L25-L34))
    needs a mapping from signer keys to users, such as a list of keys in
    each user's contact document. That is a separate proposal; the account
    document's URL can't serve as the author, since outside keyhive it
    grants write access to the whole account.
- **Invisible trailing steps.** A press crossing only invisible steps (e.g.
  redo after the last visible step) reports `applied: false`; `canUndo` /
  `canRedo` can't know in advance without applying the inverse.
  How to best design the solution for this is unclear. Ideally, we would jump
  over invisible changes automatically.
- **Grouping across tools.** Tools sharing a history with different
  `groupDelayMs` currently use the largest; per-tool grouping would need to know
  which tool made a change.

## 12. References

1. Yjs, _Y.UndoManager_. https://docs.yjs.dev/api/undo-manager
2. Loro, _Undo/Redo_.
   https://github.com/loro-dev/loro-docs/blob/main/pages/docs/advanced/undo.mdx
3. Automerge, _Remove undo/redo_ (issue #985).
   https://github.com/automerge/automerge/issues/985
4. Zaboople, _The Great Undo-Redo Quandary_.
   https://github.com/zaboople/klonk/blob/master/TheGURQ.md
5. Onset Software, _automerge-repo-undo-redo_.
   https://github.com/onsetsoftware/automerge-repo-undo-redo
6. tldraw, _Editor: history_. https://tldraw.dev/docs/editor
7. CodeMirror, _@codemirror/commands: history_.
   https://codemirror.net/docs/ref/#commands.history
8. GNU Emacs Manual, _Undo_.
   https://www.gnu.org/software/emacs/manual/html_node/emacs/Undo.html
9. Automerge issue #1607. https://github.com/automerge/automerge/issues/1607
10. Automerge issue #1598. https://github.com/automerge/automerge/issues/1598
11. Automerge issue #1653. https://github.com/automerge/automerge/issues/1653
12. Automerge issue #1593. https://github.com/automerge/automerge/issues/1593
