import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Patch, Prop } from "@automerge/automerge/slim";

import type { AppliedEvent } from "./history.js";
import { UNDO_MARKER } from "./marker.js";
import type { Undo } from "./realm.js";

/**
 * Marks step boundaries where CodeMirror's own `history()` would: before a
 * user transaction that changes the document and isn't typing or deleting
 * (a paste, a drop, an accepted completion), on a selection-only user
 * transaction (a click, arrow keys), and around transactions annotated with
 * `isolateHistory`.
 *
 * It runs as a transaction extender, which sees each transaction before
 * automerge-codemirror writes it to the document; an update listener runs
 * too late. Use it instead of `history()` and `historyKeymap`: the realm's
 * key binding sends Cmd/Ctrl+Z to the shared history. It also marks the
 * editor's content with `data-patchwork-undo`, which tells the key binding
 * that this editor's edits are the document's; CodeMirror editors without it
 * (a comment draft, a chat input) keep their own undo.
 */
export function undoBoundaries(undo: Pick<Undo, "checkpoint">): Extension {
  let after = false;
  const boundaries = EditorState.transactionExtender.of((tr) => {
    if (after) {
      after = false;
      undo.checkpoint();
    }
    const isolate = tr.annotation(isolateHistory);
    if (isolate === "before" || isolate === "full") undo.checkpoint();
    if (isolate === "after" || isolate === "full") after = true;
    // Only the user's own transactions: automerge-codemirror applies remote
    // changes as transactions without a user event.
    if (tr.annotation(Transaction.userEvent) === undefined) return null;
    if (tr.docChanged) {
      if (!tr.isUserEvent("input.type") && !tr.isUserEvent("delete")) {
        undo.checkpoint();
      }
    } else if (tr.isUserEvent("select")) {
      undo.checkpoint();
    }
    return null;
  });
  return [boundaries, EditorView.contentAttributes.of({ [UNDO_MARKER]: "" })];
}

/**
 * After an undo or redo, put the cursor where the text at `path` changed,
 * as CodeMirror's history restores the selection. Returns the teardown.
 */
export function followUndo(
  view: EditorView,
  undo: Pick<Undo, "onApplied">,
  path: Prop[]
): () => void {
  return undo.onApplied((event: AppliedEvent) => {
    const head = changedPosition(event.patches, path);
    if (head === undefined) return;
    // automerge-codemirror applies the change to the view from the handle's
    // change event; select once that has gone through.
    queueMicrotask(() => {
      const at = Math.min(head, view.state.doc.length);
      view.dispatch({
        selection: EditorSelection.cursor(at),
        scrollIntoView: true,
      });
    });
  });
}

/** The end of the last change the patches made to the text at `path`. */
export function changedPosition(
  patches: readonly Patch[],
  path: readonly Prop[]
): number | undefined {
  let head: number | undefined;
  for (const patch of patches) {
    if (patch.path.length !== path.length + 1) continue;
    if (!path.every((prop, i) => patch.path[i] === prop)) continue;
    const index = patch.path[path.length];
    if (typeof index !== "number") continue;
    if (patch.action === "splice") head = index + patch.value.length;
    else if (patch.action === "del") head = index;
  }
  return head;
}
