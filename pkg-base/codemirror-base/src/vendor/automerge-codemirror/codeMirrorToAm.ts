import * as A from "@automerge/automerge"
import { Text, Transaction } from "@codemirror/state"
import { isReconcileTx } from "./plugin.js"
import { type DocHandle } from "./DocHandle.js"

export const applyCmTransactionsToAmHandle = (
  handle: DocHandle<unknown>,
  path: A.Prop[],
  transactions: Transaction[]
): A.Heads | undefined => {
  const transactionsWithChanges = transactions.filter(
    tr => !isReconcileTx(tr) && !tr.changes.empty
  )

  if (transactionsWithChanges.length === 0) {
    return
  }

  // A read-only handle (e.g. pinned to historical heads) rejects writes:
  // never forward editor changes to it. The automergeReadOnly extension
  // keeps the editor from producing such changes in the first place.
  if (handle.isReadOnly?.()) {
    return
  }

  handle.change((doc: A.Doc<unknown>) => {
    transactionsWithChanges.forEach(tr => {
      tr.changes.iterChanges(
        (
          fromA: number,
          toA: number,
          fromB: number,
          _toB: number,
          inserted: Text
        ) => {
          // We are cloning the path as `am.splice` calls `.unshift` on it, modifying it in place,
          // causing the path to be broken on subsequent changes
          A.splice(doc, path.slice(), fromB, toA - fromA, inserted.toString())
        }
      )
    })
  })

  return A.getHeads(handle.doc())
}
