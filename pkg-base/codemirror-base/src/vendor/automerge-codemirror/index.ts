import type * as A from "@automerge/automerge"
import type { Extension } from "@codemirror/state"
import { automergeSyncPlugin } from "./plugin.js"
import { automergeHistory } from "./history.js"
import { automergeReadOnly } from "./readOnly.js"
import type { DocHandle } from "./DocHandle.js"

type AutomergePluginConfig = {
  handle: DocHandle<unknown>
  path: A.Prop[]
}

/**
 * The recommended entry point: two-way sync plus the pieces entangled with
 * it — undo history that resets when the handle's backing is swapped, and
 * read-only tracking for handles that reject writes.
 *
 * Don't add another `history()` to the editor (`basicSetup` includes one):
 * the bundled history must own the only copy for its reset to work. Each
 * piece is also exported individually for à-la-carte use.
 */
export const automergePlugin = ({
  handle,
  path,
}: AutomergePluginConfig): Extension => [
  automergeSyncPlugin({ handle, path }),
  automergeHistory({ handle }),
  automergeReadOnly({ handle }),
]

export { automergeSyncPlugin } from "./plugin.js"
export { automergeHistory } from "./history.js"
export { automergeReadOnly } from "./readOnly.js"
export type { DocHandle, DocHandleChangePayload } from "./DocHandle.js"
