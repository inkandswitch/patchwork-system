/**
 * Marks an editor whose edits are the document's: the realm's key binding
 * takes its Cmd/Ctrl+Z, where other editable elements keep the browser's
 * own undo. The editor helpers set it.
 */
export const UNDO_MARKER = "data-patchwork-undo";
