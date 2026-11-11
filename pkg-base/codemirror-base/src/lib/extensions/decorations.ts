import { createEffect } from "solid-js";

/** CodeMirror */
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/**
 * Create a CodeMirror extension for managing decorations.
 * @param decorations An accessor function that returns the decorations (for reactivity).
 * @returns A tuple containing the extension and a function to create an effect for updating the
 decorations.
 */
export function createDecorationsExtension(decorations: () => DecorationSet) {
  const setDecorations = StateEffect.define<DecorationSet>();
  const decorationsField = StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setDecorations)) return e.value;
      }
      if (tr.docChanged) return value.map(tr.changes);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const createDecorationsEffect = (view: EditorView) =>
    createEffect(() => {
      decorations() &&
        view.dispatch({
          effects: setDecorations.of(decorations!()),
        });
    });

  return [decorationsField, createDecorationsEffect] as const;
}
