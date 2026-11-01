import { Plugin, PluginKey, type Transaction } from "prosemirror-state";

import { UNDO_MARKER } from "./marker.js";
import type { Undo } from "./realm.js";

/**
 * The meta key `closeHistory(tr)` from `prosemirror-history` sets (the key
 * of its internal `PluginKey("closeHistory")`), so tools keep calling it to
 * end a step. Tested against prosemirror-history 1.5.
 */
const CLOSE_HISTORY = "closeHistory$";

export const undoBoundariesKey = new PluginKey("patchwork-undo");

/**
 * A ProseMirror plugin that connects the editor to the undo service, in
 * place of `prosemirror-history` and its undo keymap:
 *
 * - It marks the editor with `data-patchwork-undo`, so the realm's key
 *   binding (and the browser's Edit menu) send Cmd/Ctrl+Z in the editor to
 *   the shared history instead of leaving it to the browser.
 * - It ends a step where `prosemirror-history` would start a new group
 *   beyond what time and adjacency tell: at a transaction marked with
 *   `closeHistory(tr)`. It does so in `filterTransaction`, which runs before
 *   the sync plugin (`@automerge/prosemirror`) writes the transaction to the
 *   document in its `appendTransaction`.
 *
 * Grouping by time and by adjacency is the service's own and matches
 * `prosemirror-history`'s (500 ms, touching ranges).
 */
export function undoBoundaries(undo: Pick<Undo, "checkpoint">): Plugin {
  return new Plugin({
    key: undoBoundariesKey,
    props: {
      attributes: { [UNDO_MARKER]: "" },
    },
    filterTransaction(tr: Transaction) {
      if (tr.getMeta(CLOSE_HISTORY)) undo.checkpoint();
      return true;
    },
  });
}
