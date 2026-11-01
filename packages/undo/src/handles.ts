import type { DocHandle, DocumentId } from "@automerge/automerge-repo/slim";

/** The surface of a repo the undo service needs: its handle index. */
export type HandleIndex = {
  readonly handles: Record<DocumentId, DocHandle<unknown>>;
};

type Unwrappable = DocHandle<unknown> & {
  backingHandle?: DocHandle<unknown>;
  path?: readonly unknown[];
};

/**
 * The live handle behind `handle`: an `OverlayHandle` (a draft, a remapped
 * view) is unwrapped to its current backing, since the overlay and the base
 * document are different histories.
 */
export function backingOf(handle: DocHandle<unknown>): DocHandle<unknown> {
  let current = handle as Unwrappable;
  while (current.backingHandle) current = current.backingHandle as Unwrappable;
  return current;
}

/**
 * The root handle of the document behind `handle`. The engine needs the
 * whole document (its actor, its change history), so a sub-handle is
 * resolved to its root: sub-handles share their root's document, and a
 * `Repo` only ever hands out root handles, so the root is the repo's handle
 * for the same document id.
 */
export function rootOf(
  handle: DocHandle<unknown>,
  repo?: HandleIndex
): DocHandle<unknown> {
  const backing = backingOf(handle) as Unwrappable;
  if (!backing.path || backing.path.length === 0) return backing;
  const index =
    repo ?? (globalThis as { repo?: HandleIndex }).repo ?? undefined;
  const root = index?.handles[backing.documentId];
  if (!root) {
    throw new Error(
      `patchwork-undo: ${handle.url} is a sub-handle and its root isn't in ` +
        `the repo; pass the root handle or { repo }`
    );
  }
  return backingOf(root);
}
