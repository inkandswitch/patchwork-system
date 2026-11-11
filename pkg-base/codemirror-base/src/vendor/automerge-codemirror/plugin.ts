import * as A from "@automerge/automerge"
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view"
import { Transaction, Annotation } from "@codemirror/state"
import { applyCmTransactionsToAmHandle } from "./codeMirrorToAm.js"
import { applyAmPatchesToCm } from "./amToCodemirror.js"
import type { DocHandle } from "./DocHandle.js"

export const reconcileAnnotationType = Annotation.define<unknown>()

export const isReconcileTx = (tr: Transaction): boolean =>
  !!tr.annotation(reconcileAnnotationType)

type AutomergeSyncPluginConfig = {
  handle: DocHandle<unknown>
  path: A.Prop[]
}

export const automergeSyncPlugin = ({
  handle,
  path,
}: AutomergeSyncPluginConfig) => {
  if (!handle.isReady()) {
    throw new Error(
      "ensure the handle is ready before initializing the automergeSyncPlugin"
    )
  }

  return ViewPlugin.fromClass(
    class {
      view: EditorView
      reconciledHeads = A.getHeads(handle.doc())
      isProcessingCmTransaction = false

      constructor(view: EditorView) {
        this.view = view

        this.onChange = this.onChange.bind(this)
        handle.on("change", this.onChange)
      }

      update(update: ViewUpdate) {
        // start processing codemirror transaction
        // changes that are created through the transaction are ignored in the change listener on the handle
        this.isProcessingCmTransaction = true

        const newHeads = applyCmTransactionsToAmHandle(
          handle,
          path,
          update.transactions as Transaction[]
        )

        if (newHeads) {
          this.reconciledHeads = newHeads
        }

        // finish processing transaction
        this.isProcessingCmTransaction = false
      }

      // Changes with a replaced scope (the handle was re-pointed at a
      // different backing document) need no special-casing here. A.diff
      // ignores heads that aren't in the doc's history, treating that side
      // as the empty document: when the backings share history (heads
      // pinning, clones) it yields minimal patches that preserve the
      // selection, and when they share nothing it degenerates into
      // full-document patches that rebuild the editor wholesale. Either
      // way the patches are kept off the undo stack by applyAmPatchesToCm.
      // The history and read-only extensions are the ones that consume the
      // `scopeReplaced` flag.
      onChange = () => {
        // ignore changes that where triggered while processing a codemirror transaction
        if (this.isProcessingCmTransaction) {
          return
        }

        const currentHeads = A.getHeads(handle.doc())
        if (A.equals(currentHeads, this.reconciledHeads)) {
          return
        }

        // get the diff between the reconciled heads and the new heads
        // and apply that to the codemirror doc
        const patches = A.diff(handle.doc(), this.reconciledHeads, currentHeads)
        applyAmPatchesToCm(this.view, path, patches)
        this.reconciledHeads = currentHeads
      }

      destroy() {
        handle.off("change", this.onChange)
      }
    }
  )
}
