import { parseAutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  type SideboardDragAndDropItem,
  dragstack,
  addToDragstack,
  clearDragstack,
  setCopyMode,
  setDragging,
  setDragSourceItems,
  setDragOriginView,
} from "./dnd.ts";

/**
 * Start dragging a row (and the rest of the selection, if the row is in it):
 * fill the dataTransfer with every format our drop targets and the browser
 * understand, set a drag image, and remember where the drag came from.
 */
export function startDrag(
  event: DragEvent,
  row: SideboardDragAndDropItem,
  element: { toolId?: string | null },
  dragOut: { addTo(dataTransfer: DataTransfer): void }
) {
  const data = event.dataTransfer!;
  if (!dragstack.has(row.id)) {
    clearDragstack();
    addToDragstack(row.id, row);
  }
  const items = [...dragstack.values()];
  const urls = items.map((item) => item.url);
  const ids = items.map((item) => item.id);

  // Alt drags copy
  setCopyMode(event.altKey);
  // "all" so the drag advertises copy, move, AND link. Every sideboard
  // drop is a link at the automerge level (same url, no doc cloned), and
  // link is also what lets Chrome offer split-view when dragging out.
  // Internal dragover handlers still set dropEffect to copy/move, which
  // stay valid as a subset of "all".
  data.effectAllowed = "all";

  // Expose a real URL list so the browser treats the drag as a link —
  // this is what enables Chrome's split-view when dragging a doc out of
  // the app. Our own drop targets prefer text/x-patchwork-dnd, so this
  // doesn't change in-app behaviour.
  const urlList =
    urls
      .map(
        (url) =>
          location.protocol +
          "//" +
          location.host +
          `/#doc=${parseAutomergeUrl(url).documentId}`
      )
      .join("\r\n") + "\r\n";
  data.items.add(urlList, "text/uri-list");
  // Keep custom types for our internal DnD system
  data.items.add(JSON.stringify(ids), "text/x-sideboard-ids");
  data.items.add(JSON.stringify(urls), "text/x-patchwork-urls");
  // Structured data with source tracking. The move-vs-copy decision keys off
  // the origin *element* (setDragOriginView below), not this toolId, which is
  // null for the fallback-mounted sideboard.
  data.items.add(
    JSON.stringify({ source: element.toolId, items }),
    "text/x-patchwork-dnd"
  );

  // OS drag-out: single-item only — the format carries one entry.
  if (items.length === 1) dragOut.addTo(data);

  data.setDragImage(dragPreview(items.length, row.name, event.altKey), 10, 10);

  setDragSourceItems(ids);
  setDragOriginView(element);
  setDragging(true);
}

function dragPreview(count: number, name: string, copy: boolean) {
  const preview = document.createElement("div");
  preview.style.cssText = `
    position: absolute;
    top: -1000px;
    background: var(--document-list-primary);
    padding: 0.5rem 0.75rem;
    border-radius: var(--document-list-radius);
    font-family: inherit;
    font-size: 0.9rem;
    pointer-events: none;
    color: var(--document-list-primary-line);
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  `;
  const modeText = copy ? " (copy)" : "";
  preview.textContent = count === 1 ? name + modeText : `${count} items${modeText}`;
  document.body.appendChild(preview);
  // the browser snapshots it during dragstart, so it can go straight after
  setTimeout(() => preview.remove(), 0);
  return preview;
}
