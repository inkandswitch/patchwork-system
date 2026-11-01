// A CodeMirror text tool with the undo service. Its own history is gone
// (no `history()`, no `historyKeymap`): Cmd/Ctrl+Z goes to the realm's history of
// the document, which every tool on it shares.
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import * as A from "@automerge/automerge/slim";
import { undoFor } from "@inkandswitch/patchwork-undo";
import {
  followUndo,
  undoBoundaries,
} from "@inkandswitch/patchwork-undo/codemirror";

/** Mount a text editor for the string at `path` in `handle`'s document. */
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
  return () => {
    stopFollowing();
    view.destroy();
    undo.dispose();
  };
}

function read(doc, path) {
  return path.reduce((value, prop) => value?.[prop], doc) ?? "";
}

// The smallest two-way binding between the editor and the text, standing in
// for automerge-codemirror: the user's changes are spliced into the
// document, and the document's other changes (a collaborator's, an undo) are
// dispatched to the editor.
function syncText(handle, path) {
  return ViewPlugin.fromClass(
    class {
      writing = false;

      constructor(view) {
        this.view = view;
        this.onChange = () => {
          if (!this.writing) this.pull();
        };
        handle.on("change", this.onChange);
      }

      update(update) {
        for (const tr of update.transactions) {
          if (!tr.docChanged || !tr.annotation(Transaction.userEvent)) continue;
          const changes = [];
          tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            changes.push([from, to, inserted.toString()]);
          });
          this.writing = true;
          handle.change((doc) => {
            for (const [from, to, insert] of changes.reverse()) {
              A.splice(doc, path, from, to - from, insert);
            }
          });
          this.writing = false;
        }
      }

      pull() {
        const text = read(handle.doc(), path);
        const current = this.view.state.doc.toString();
        if (text === current) return;
        let start = 0;
        while (start < text.length && text[start] === current[start]) start++;
        let end = 0;
        while (
          end < text.length - start &&
          end < current.length - start &&
          text[text.length - 1 - end] === current[current.length - 1 - end]
        ) {
          end++;
        }
        this.view.dispatch({
          changes: {
            from: start,
            to: current.length - end,
            insert: text.slice(start, text.length - end),
          },
        });
      }

      destroy() {
        handle.off("change", this.onChange);
      }
    }
  );
}

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "undo-example-text",
    name: "Undo example: text",
    async load() {
      return { init: (doc) => (doc.text = ""), getTitle: () => "Text" };
    },
  },
  {
    type: "patchwork:tool",
    id: "undo-example-text",
    name: "Text (undo example)",
    supportedDatatypes: ["undo-example-text"],
    async load() {
      return (handle, element) => mountText(handle, element);
    },
  },
];
