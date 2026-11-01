import type { UndoState } from "./history.js";

/**
 * Selector of host UI (an Edit menu, a toolbar button): the undo state of
 * the document at `url`, or, without `url`, of the document the user used
 * last. Answered with {@link UndoStatus}; takes {@link UndoCommand}s.
 */
export const UNDO = "patchwork:undo";

/**
 * Selector a realm opens per history to announce it to the provider. The
 * consumer sends {@link SourceState}; the provider answers with
 * {@link SourceCommand}s. Internal to this package.
 */
export const UNDO_SOURCE = "patchwork:undo-source";

export type UndoSelector = { type: typeof UNDO; url?: string };

export type UndoStatus = UndoState & {
  /** The document the state is about; null if no history is known. */
  url: string | null;
};

export type UndoCommand = "undo" | "redo";

export type SourceSelector = {
  type: typeof UNDO_SOURCE;
  /** The presented document (what the host opened). */
  url: string;
  /** The document edits go to (a draft's clone, or `url` itself). */
  backing: string;
};

export type SourceState = UndoState & {
  /** When the user last used the history's element, in epoch ms. */
  active: number;
};

export type SourceCommand = { command: UndoCommand };
