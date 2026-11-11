import { createSignal } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export const [dragging, setDragging] = createSignal(false);
export const [copyMode, setCopyMode] = createSignal(false);

// Dragging the "new document" button. Carries no document — on drop it asks the
// list to open a pending-doc placeholder at the drop location instead of moving
// anything.
export const NEW_DOC_DND_TYPE = "application/x-patchwork-new-doc";
export const [newDocDragging, setNewDocDragging] = createSignal(false);

export function isNewDocDrag(event: DragEvent) {
  return event.dataTransfer?.types.includes(NEW_DOC_DND_TYPE) ?? false;
}

/**
 * Where a drop will land. It's the one answer both the drop line (while
 * dragging) and the drop itself use, so the picture can't disagree with the
 * result: `folderUrl` + `index` is the insertion point, and `id` + `position`
 * say what to draw.
 *
 * - above/below: a line on the row whose `data-dnd-item` is `id`
 * - inside: the folder whose `data-dnd-container` is `id` lights up
 * - end: a line after the last row of the list whose container is `id`
 */
export type DropSpot = {
  id: string;
  position: "above" | "below" | "inside" | "end";
  folderUrl: AutomergeUrl;
  index: number;
};

/** The spot for a row: above/below go into its parent, inside into itself. */
export function rowSpot(
  row: { id: string; url: AutomergeUrl; parentUrl: AutomergeUrl; index: number },
  position: "above" | "below" | "inside"
): DropSpot {
  if (position === "inside") {
    return { id: row.id, position, folderUrl: row.url, index: 0 };
  }
  return {
    id: row.id,
    position,
    folderUrl: row.parentUrl,
    index: position === "above" ? row.index : row.index + 1,
  };
}

/** The spot after the last row of a folder's list. */
export function endSpot(folderUrl: AutomergeUrl, length: number): DropSpot {
  return { id: folderUrl, position: "end", folderUrl, index: length };
}

// Drop target is a plain variable — not a SolidJS signal.
// Visual state is updated via direct DOM manipulation to avoid
// O(n) reactive updates across all items on every dragover.
let currentDropTarget: DropSpot | null = null;

export function getDropTarget() {
  return currentDropTarget;
}

// Every mounted copy of a row shares its id (the same folder can be open in
// two places, or in two panels), and they all stand for the same docref, so
// every copy gets the mark — not just whichever one comes first in the DOM.
function marked(attribute: string, id: string) {
  return document.querySelectorAll(`[${attribute}="${CSS.escape(id)}"]`);
}

function updateDropTargetDOM(
  oldTarget: DropSpot | null,
  newTarget: DropSpot | null
) {
  if (oldTarget) {
    for (const item of marked("data-dnd-item", oldTarget.id))
      item.removeAttribute("data-dnd-droplist-state");
    for (const container of marked("data-dnd-container", oldTarget.id))
      container.removeAttribute("data-drop-state");
  }
  if (newTarget) {
    if (newTarget.position === "inside" || newTarget.position === "end") {
      for (const container of marked("data-dnd-container", newTarget.id))
        container.setAttribute("data-drop-state", newTarget.position);
    }
    if (newTarget.position !== "end") {
      for (const item of marked("data-dnd-item", newTarget.id))
        item.setAttribute("data-dnd-droplist-state", newTarget.position);
    }
  }
}

// Identity for the "did this drag start and end in the same view?" question.
// The answer decides move (→ in-view) vs add-link (→ cross-view or external).
//
// The tool id can't answer it: the sideboard is shown through patchwork-view's
// *fallback* path, which never sets the `tool-id` attribute, so element.toolId
// is null — and even when set it names the tool *type*, not the instance, so
// two side-by-side views would collide. The <patchwork-view> element itself is
// the instance identity. We're single-context on the web (dragstart and drop
// run in the same window), so plain reference equality is all we need: remember
// the origin element on dragstart, compare it on drop, clear it on dragend.
let dragOriginView: object | null = null;
export function setDragOriginView(element: object | null) {
  dragOriginView = element;
}
export function isSameDragOriginView(element: object): boolean {
  return dragOriginView != null && dragOriginView === element;
}

export type SideboardDragAndDropItem = {
  id: string;
  url: AutomergeUrl;
  type: string;
  name: string;
  source: string;
};

// Plain Map — not reactive. aria-checked is updated via DOM manipulation
// to avoid O(n) reactive updates when selection changes.
export const dragstack = new Map<string, SideboardDragAndDropItem>();

function setDragChecked(id: string, checked: boolean) {
  for (const el of marked("data-dnd-item", id)) {
    if (checked) {
      el.setAttribute("aria-checked", "true");
    } else {
      el.removeAttribute("aria-checked");
    }
  }
}

export function addToDragstack(id: string, item: SideboardDragAndDropItem) {
  dragstack.set(id, item);
  setDragChecked(id, true);
}

export function removeFromDragstack(id: string) {
  dragstack.delete(id);
  setDragChecked(id, false);
}

export function clearDragstack() {
  for (const id of dragstack.keys()) {
    setDragChecked(id, false);
  }
  dragstack.clear();
}

export function setDragSourceItems(ids: string[]) {
  for (const id of ids) {
    for (const el of marked("data-dnd-item", id))
      el.setAttribute("data-dnd-dragging", "");
  }
}

export function clearDragSourceItems() {
  for (const el of document.querySelectorAll("[data-dnd-dragging]")) {
    el.removeAttribute("data-dnd-dragging");
  }
}

export function isAbove(clientY: number, element: Element) {
  const rect = element.getBoundingClientRect();
  const offset = clientY - rect.top;
  return offset < rect.height / 2;
}

export function clearDropTarget() {
  updateDropTargetDOM(currentDropTarget, null);
  currentDropTarget = null;
}

export function setDropTarget(target: DropSpot | null) {
  // Only update if actually changed
  const current = currentDropTarget;
  if (!current && !target) return;
  if (
    current &&
    target &&
    current.id === target.id &&
    current.position === target.position &&
    current.folderUrl === target.folderUrl &&
    current.index === target.index
  ) {
    return;
  }

  updateDropTargetDOM(current, target);
  currentDropTarget = target;
}
