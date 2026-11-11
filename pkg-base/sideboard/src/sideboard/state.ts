import { createSignal } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";

// A "new document" drag (or click) is asking for a doc to be created inside the
// folder at `containerUrl`, inserted at `index`. The DocumentList whose handle
// matches `containerUrl` renders a placeholder row + type picker there.
export const [pendingNewDoc, setPendingNewDoc] = createSignal<{
  containerUrl: AutomergeUrl;
  index: number;
} | null>(null);

export function filterMatches(filter: string, string?: string) {
  const lower = string?.toLowerCase();
  return (
    !!lower &&
    filter
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => lower.includes(term))
  );
}

export const [renaming, setRenaming] = createSignal("");

// The set of folder URLs that lie on the path from the root to a currently
// selected document. A folder reads this to auto-expand itself so the selected
// doc is revealed, even when it sits in a deeply nested (and otherwise
// unmounted) subtree. Computed by the panel whenever the selection changes; see
// foldersToReveal in document-list/auto-expand.ts.
export const [autoExpandedFolders, setAutoExpandedFolders] = createSignal<
  Set<AutomergeUrl>
>(new Set());

// The row whose context menu is open. Rows don't own a menu each (a Kobalte
// menu per row is far too heavy for big trees); the panel renders one shared
// menu for whichever row last asked, anchored at the pointer.
export interface MenuTarget {
  x: number;
  y: number;
  element: HTMLElement;
  id: string;
  url: AutomergeUrl;
  name: string;
  type: string;
  openWith(toolId?: string): void;
  startRenaming(): void;
  remove(): void;
  createInside?(datatype: Plugin<DatatypeDescription>): void;
}

export const [menuTarget, setMenuTarget] = createSignal<MenuTarget | null>(
  null
);

// Why the last drop didn't (fully) happen, shown in the panel of the view it
// was dropped on (`element`) until it times out. See dnd/drop-into.ts.
export const [dropError, setDropError] = createSignal<{
  element: object;
  message: string;
} | null>(null);
