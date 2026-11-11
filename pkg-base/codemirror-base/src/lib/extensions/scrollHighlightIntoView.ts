import { createEffect } from "solid-js";

/** CodeMirror */
import { EditorView } from "@codemirror/view";
import { EditorSelection, type Extension } from "@codemirror/state";

/**
 * Create a CodeMirror extension that scrolls the highlighted range into view
 * when it changes.
 *
 * Uses the "nearest" scroll strategy, so a highlight that's already on screen
 * is left untouched and an off-screen one is scrolled just into frame -- i.e.
 * "scroll the highlight into view only if it isn't already there". Handy for
 * following focus/selection driven by other views (e.g. picking a comment).
 *
 * @param target An accessor returning the [from, to] range to reveal, or null.
 * @returns A tuple of the extension and a function to create the scroll effect.
 */
export function createScrollHighlightIntoViewExtension(
  target: () => readonly [number, number] | null
) {
  // Scrolling is a fire-and-forget transaction effect with no editor state to
  // hold, so there's nothing to add to the editor. The empty extension just
  // keeps the [extension, effectFactory] shape shared with the siblings.
  const extension: Extension = [];

  const createScrollHighlightIntoViewEffect = (view: EditorView) =>
    createEffect(() => {
      const range = target();
      if (!range) return;
      // Clamp to the live doc: a target resolved against a slightly different
      // doc revision could otherwise point past the end and throw.
      const docLength = view.state.doc.length;
      const from = Math.min(range[0], docLength);
      const to = Math.min(range[1], docLength);
      view.dispatch({
        effects: EditorView.scrollIntoView(EditorSelection.range(from, to), {
          x: "nearest",
          y: "nearest",
        }),
      });
    });

  return [extension, createScrollHighlightIntoViewEffect] as const;
}
