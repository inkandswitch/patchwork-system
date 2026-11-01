import type { IgnorePath, UndoHistoryOptions } from "./history.js";
import { takenByRealm, type Undo } from "./realm.js";

/**
 * The parts of a tldraw `Editor` the binding touches. `history._mark` is
 * internal to tldraw: every history mark (`markHistoryStoppingPoint`, and
 * the marks tools and interactions set) goes through it. So is
 * `store._flushHistory`: store listeners (and so a binding's writes to the
 * document) are batched to the next frame, and the binding flushes them so
 * they land on the right side of a boundary. Tested against
 * `@tldraw/editor` 5.5.
 */
export type TldrawEditorLike = {
  history: { _mark(id: string): unknown };
  store: { _flushHistory?(): void };
  undo(): unknown;
  redo(): unknown;
  canUndo(): boolean;
  canRedo(): boolean;
};

/**
 * Ignore tldraw's per-user record (`user:…`) in the store at `storePath`:
 * tldraw re-creates it immediately whenever an undo deletes it, and unless
 * ignored, that re-creation ends every undo run, so redo never works.
 */
export function tldrawIgnore(
  storePath: readonly string[] = ["store"]
): IgnorePath {
  return (path) =>
    storePath.every((prop, i) => path[i] === prop) &&
    typeof path[storePath.length] === "string" &&
    (path[storePath.length] as string).startsWith("user:");
}

/**
 * Options for `undoFor` on a tldraw document: tldraw marks the boundaries
 * itself, so steps are never split by time (a long drag stays one step).
 */
export function tldrawOptions(
  storePath: readonly string[] = ["store"]
): UndoHistoryOptions {
  return { groupDelayMs: Infinity, ignore: tldrawIgnore(storePath) };
}

/**
 * Route a tldraw editor's undo and redo to the shared history, and end a
 * step at every tldraw history mark. Returns the teardown.
 *
 * tldraw's own history keeps recording (its marks, `bailToMark` and
 * `squashToMark` still work); only undo, redo and their availability go to
 * the service. For the UI's menus and toolbar, also pass
 * {@link tldrawOverrides} to `<Tldraw overrides>`.
 */
export function bindTldraw(
  editor: TldrawEditorLike,
  undo: Pick<Undo, "undo" | "redo" | "checkpoint" | "canUndo" | "canRedo">
): () => void {
  const history = editor.history;
  const flush = () => editor.store._flushHistory?.();
  const mark = history._mark;
  history._mark = function (this: unknown, id: string) {
    flush();
    undo.checkpoint();
    return mark.call(this, id);
  };
  const own = {
    undo: editor.undo,
    redo: editor.redo,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
  };
  editor.undo = () => {
    if (fromRealm()) return editor;
    flush();
    undo.undo();
    return editor;
  };
  editor.redo = () => {
    if (fromRealm()) return editor;
    flush();
    undo.redo();
    return editor;
  };
  editor.canUndo = () => undo.canUndo;
  editor.canRedo = () => undo.canRedo;
  return () => {
    history._mark = mark;
    Object.assign(editor, own);
  };
}

type Action = { onSelect: (source: string) => void } & Record<string, unknown>;

/**
 * `<Tldraw overrides>` whose `undo` and `redo` actions (menu items, toolbar
 * buttons, their shortcuts) use the shared history.
 */
export function tldrawOverrides(undo: Pick<Undo, "undo" | "redo">) {
  return {
    actions(_editor: unknown, actions: Record<string, Action>) {
      if (actions.undo) {
        actions.undo = {
          ...actions.undo,
          onSelect: () => void (fromRealm() || undo.undo()),
        };
      }
      if (actions.redo) {
        actions.redo = {
          ...actions.redo,
          onSelect: () => void (fromRealm() || undo.redo()),
        };
      }
      return actions;
    },
  };
}

/**
 * Whether the event being handled is a key press the realm's key binding
 * takes. tldraw's shortcut handlers can see Cmd/Ctrl+Z before the realm's
 * listener does; that press is the realm's, and undoing it here as well
 * would undo twice.
 */
function fromRealm(): boolean {
  return takenByRealm((globalThis as { event?: Event }).event);
}
