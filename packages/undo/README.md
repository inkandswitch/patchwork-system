# @inkandswitch/patchwork-undo

Undo and redo of a realm's own edits to Automerge documents, as a service
every Patchwork tool shares.

- **One history per realm and document.** Every tool in the realm that edits
  a document shares its history; two tabs, or two realms, undo
  independently.
- **Only your own changes.** A change is yours if its actor is the
  document's actor in this realm. An undo is a new change that reverts only
  those, leaving collaborators' work alone, and it syncs like any other.
- **Nothing becomes unreachable.** Consecutive undo and redo presses form a
  _run_; the next edit turns the run into one step, which can itself be
  undone.
- **One key binding.** Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z (and Ctrl+Y outside macOS) go to
  the document under the event's target, or to the one the user used last.
  Inputs, textareas, selects and contenteditables keep the browser's own
  undo, unless an editor is marked with `data-patchwork-undo` as writing to
  the document (`undoBoundaries` marks CodeMirror's).

The design, its rationale and its limits are in
[`docs/proposals/document-undo.md`](../../docs/proposals/document-undo.md).

## Use it in a tool

```js
import { undoFor } from "@inkandswitch/patchwork-undo";

export function mountCanvas(handle, element) {
  // ...
  const undo = undoFor(element, handle);
  // ...
  const onPointerDown = (event) => {
    handle.change((doc) => {
      doc.dots ??= [];
      doc.dots.push({
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    });
    // Each click is a step of its own.
    undo.checkpoint();
  };
  // ...
  return () => {
    undo.dispose();
  };
}
```

That is all a tool needs: `undoFor(element, handle)` finds (or creates) the
history of the document behind `handle` and binds the keys to `element`.
Changes less than 500 ms apart form one step; `checkpoint()` ends a step
where the tool knows a boundary. (From
[`examples/canvas.js`](examples/canvas.js).)

### Options

```ts
undoFor(element, handle, {
  groupDelayMs: 500, // Infinity: only checkpoint() ends a step
  ignore: (path) => false, // paths left out of undo, besides top-level "@…" keys
  conflict: "skip", // or "force": restore values others changed since
  repo, // where to find the root handle of a sub-handle (default window.repo)
});
```

The returned `Undo` has `undo()`, `redo()`, `checkpoint()`, `canUndo`,
`canRedo`, `subscribe(listener)` (called with `{ canUndo, canRedo }`),
`onApplied(listener)` (called with the patches of every press, to move a
selection) and `dispose()`. `undo()` and `redo()` return what they did,
including the paths they skipped because someone else changed them since.

### CodeMirror

Drop `history()` and `historyKeymap`, and add the boundaries:

```js
import { undoFor } from "@inkandswitch/patchwork-undo";
import {
  followUndo,
  undoBoundaries,
} from "@inkandswitch/patchwork-undo/codemirror";

export function mountText(handle, element, { path = ["text"] } = {}) {
  const undo = undoFor(element, handle);
  const view = new EditorView({
    parent: element,
    state: EditorState.create({
      doc: read(handle.doc(), path),
      extensions: [
        keymap.of(defaultKeymap),
        undoBoundaries(undo),
        syncText(handle, path),
      ],
    }),
  });
  const stopFollowing = followUndo(view, undo, path);
  // ...
}
```

`undoBoundaries` ends a step where CodeMirror's own history would (a paste,
a click, `isolateHistory`), from a transaction extender, which runs before
the change is written to the document. `followUndo` moves the cursor to what
an undo changed. With these, CodeMirror's history and the service produce
the same texts for the same transactions
([`test/codemirror.test.ts`](test/codemirror.test.ts)). (From
[`examples/text.js`](examples/text.js).)

### ProseMirror

Drop `prosemirror-history` and its keymap, and add the plugin:

```ts
import { undoFor } from "@inkandswitch/patchwork-undo";
import { undoBoundaries } from "@inkandswitch/patchwork-undo/prosemirror";

const undo = undoFor(root, handle);
const view = new EditorView(root, {
  state: EditorState.create({
    schema,
    doc: pmDoc,
    plugins: [plugin, undoBoundaries(undo)],
  }),
});
```

`plugin`, `schema` and `pmDoc` come from `@automerge/prosemirror`'s
`init(handle, path)`. `undoBoundaries` marks the editor so Cmd/Ctrl+Z in it
goes to the service, and ends a step at `closeHistory(tr)`, as
`prosemirror-history` does. Bundle this subpath with your tool: ProseMirror
isn't in Patchwork's import map. With these, `prosemirror-history` and the
service produce the same texts for the same transactions
([`test/prosemirror.test.ts`](test/prosemirror.test.ts)), paragraphs
and formatting included.

### tldraw

```js
import { undoFor } from "@inkandswitch/patchwork-undo";
import {
  bindTldraw,
  tldrawOptions,
  tldrawOverrides,
} from "@inkandswitch/patchwork-undo/tldraw";

const undo = undoFor(element, handle, tldrawOptions());
// in <Tldraw onMount={(editor) => bindTldraw(editor, undo)}
//          overrides={tldrawOverrides(undo)} />
```

`tldrawOptions()` sets `groupDelayMs: Infinity` (tldraw marks its own
boundaries, so a long drag stays one step) and ignores tldraw's `user:…`
record in `store`, which tldraw re-creates whenever an undo deletes it.
`bindTldraw` ends a step at every tldraw history mark (it wraps the internal
`editor.history._mark`, tested against `@tldraw/editor` 5.5) and routes
`editor.undo()` / `redo()` / `canUndo()` / `canRedo()` to the service. It
also flushes tldraw's store before each boundary, since tldraw hands store
changes to listeners on the next frame.
([`test/tldraw.test.ts`](test/tldraw.test.ts) compares it with tldraw's
own history.)

### React and Solid

`@inkandswitch/patchwork-providers-react` has `useUndo(element, handle,
options)` and `useUndoStatus(element, url?)`;
`@inkandswitch/patchwork-providers-solid` has `createUndo(element, handle,
options)` and `undoStatus(element, url?)`.

## Use it in host UI

An Edit menu or a toolbar button reaches the history of the document the
user used last (or of a given url) through the `patchwork:undo` provider,
which Patchwork mounts on every page:

```js
import { watchUndo } from "@inkandswitch/patchwork-undo";

export function mountEditMenu(element) {
  // ...
  const watch = watchUndo(element, undefined, ({ canUndo, canRedo }) => {
    undoButton.disabled = !canUndo;
    redoButton.disabled = !canRedo;
  });
  // ...
  undoButton.onclick = () => watch.undo();
  redoButton.onclick = () => watch.redo();
  // ...
}
```

(From [`examples/edit-menu.js`](examples/edit-menu.js).) Outside Patchwork,
mount the provider yourself with `registerUndoProviderElement()` and an
`<undo-provider>` around the page, or `installUndoProvider(element)`.

## Without Patchwork

`undoFor` works in any automerge-repo app. `new UndoHistory(rootHandle,
options)` is the history alone, without key binding or provider.

## Examples

[`examples/`](examples) has three tools (text, canvas, form) and a host Edit
menu as a Patchwork module (`examples/index.js`); they run in
[`test/examples.test.ts`](test/examples.test.ts) and in the end-to-end tests.

## Tests

```sh
pnpm --filter @inkandswitch/patchwork-undo test
FUZZ_SEEDS=2000 FUZZ_STEPS=500 pnpm --filter @inkandswitch/patchwork-undo exec vitest run test/fuzz.test.ts
BENCH=1 pnpm --filter @inkandswitch/patchwork-undo exec vitest run test/bench.test.ts
```
