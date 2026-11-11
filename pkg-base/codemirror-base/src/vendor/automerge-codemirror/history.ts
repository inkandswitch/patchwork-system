import { history, historyField, historyKeymap } from "@codemirror/commands"
import { Compartment, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin, keymap } from "@codemirror/view"
import type { DocHandle, DocHandleChangePayload } from "./DocHandle.js"

type AutomergeHistoryConfig = {
  handle: DocHandle<unknown>
}

/**
 * Undo/redo history that understands handles whose backing document can be
 * swapped in place: the stack is reset whenever the handle emits a `change`
 * with `scopeReplaced: true`, because the old entries describe a different
 * timeline and undo must only revert what the user has done since.
 *
 * Don't add another `history()` to the editor: the underlying history state
 * field is a module-level singleton in `@codemirror/commands`, so a second copy
 * elsewhere in the configuration keeps the field alive across the reset and defeats it.
 * If the user configures history on their own we detect this and warned about it at mount.
 */
export const automergeHistory = ({
  handle,
}: AutomergeHistoryConfig): Extension => {
  const compartment = new Compartment()
  const historyExtension = () => [history(), keymap.of(historyKeymap)]

  const resetPlugin = ViewPlugin.fromClass(
    class {
      warned = false
      destroyed = false
      readonly view: EditorView

      constructor(view: EditorView) {
        this.view = view
        this.onChange = this.onChange.bind(this)
        handle.on("change", this.onChange)
        // Probe once at mount, when the history is empty and cycling is
        // harmless: a duplicate history() warns immediately instead of on
        // the first swap. Deferred because dispatching isn't allowed while
        // the view is still initializing.
        queueMicrotask(() => {
          if (!this.destroyed) this.reset()
        })
      }

      onChange(payload?: DocHandleChangePayload) {
        if (payload?.scopeReplaced) this.reset()
      }

      // CodeMirror has no clear-history API; the sanctioned reset is cycling
      // the extension out of and back into the configuration, which drops
      // the history field's state and re-creates it empty.
      reset() {
        this.view.dispatch({ effects: compartment.reconfigure([]) })
        // With our copy out of the configuration the field must be gone; if
        // it survives, another history() is keeping it alive and the reset
        // is silently defeated.
        if (
          !this.warned &&
          this.view.state.field(historyField, false) !== undefined
        ) {
          this.warned = true
          console.warn(
            "[automerge-codemirror] another history() extension is present" +
              " in this editor's configuration, so the undo history cannot" +
              " be reset when the handle's backing is swapped. Remove the" +
              " other copy — note that basicSetup includes one."
          )
        }
        this.view.dispatch({
          effects: compartment.reconfigure(historyExtension()),
        })
      }

      destroy() {
        this.destroyed = true
        handle.off("change", this.onChange)
      }
    }
  )

  return [compartment.of(historyExtension()), resetPlugin]
}
