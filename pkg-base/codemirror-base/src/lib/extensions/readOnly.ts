import { createEffect } from "solid-js";

/** CodeMirror */
import { EditorView } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";

/**
 * Force the editor read-only regardless of the handle's state.
 *
 * This is only the override: the handle's own read-only state (e.g. a
 * heads-pinned view, including flips when its backing is swapped in place)
 * is tracked by the vendored `automergeReadOnly`, installed via
 * `createAutomergeExtension`.
 *
 * @param force Forces read-only.
 * @returns A tuple containing the extension and a function to create the
 * effect that reconfigures the extension when `force` changes.
 */
export function createReadOnlyExtension(force: () => boolean) {
  const compartment = new Compartment();

  const extensions = () =>
    force()
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [];

  const createReconfigureEffect = (view: EditorView) =>
    createEffect(() => {
      view.dispatch({
        effects: compartment.reconfigure(extensions()),
      });
    });

  return [compartment.of(extensions()), createReconfigureEffect] as const;
}
