import { createEffect } from "solid-js";

/** CodeMirror */
import { EditorView } from "@codemirror/view";
import { Compartment, Transaction } from "@codemirror/state";

/** Automerge */
import type { Prop as AutomergeProp } from "@automerge/automerge/slim";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { automergePlugin } from "../../vendor/automerge-codemirror/index.js";

/**
 * Returns a [Compartment extension, reconfig effect] tuple to sync a CodeMirror editor
 * with an Automerge handle+path. When reactive `handle` or `path` change, swaps the
 * plugin via Compartment and resets the doc from `initialDoc()` (kept off undo stack).
 */
export function createAutomergeExtension<T>(
  handle: () => DocHandle<T>,
  path: () => AutomergeProp[],
  initialDoc: () => string
) {
  const compartment = new Compartment();

  const extension = () =>
    handle() && path()
      ? automergePlugin({
          handle: handle() as any, // typescript is confused by different version of doc handle
          path: path(),
        })
      : [];

  // Reconfigures the plugin and resets the doc to initialDoc() on reactive changes; this is synthetic remote state, so it bypasses the undo stack.
  const createReconfigureEffect = (view: EditorView) =>
    createEffect(() => {
      // handle()/path()/initialDoc() are tracked; changes rerun the rebuild.
      view.dispatch({
        effects: compartment.reconfigure(extension()),
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: initialDoc(),
        },
        annotations: [
          Transaction.addToHistory.of(false),
          Transaction.remote.of(true),
        ],
      });
    });

  return [compartment.of(extension()), createReconfigureEffect] as const;
}
