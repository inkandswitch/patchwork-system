import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  dragstack,
  addToDragstack,
  removeFromDragstack,
  type SideboardDragAndDropItem,
} from "../dnd/dnd.ts";

/**
 * A cmd/ctrl-drag rubber-band selection over the document list. Attach the
 * returned `onMouseDown` to the list container.
 *
 * Rows whose bounding boxes intersect the band are added to the drag selection
 * (the `dragstack`); rows the band leaves are removed again, so the selection
 * tracks the band live. Any selection the user made before starting the band
 * (via cmd-click) is left untouched — the band only manages the rows it adds.
 */
export function createMarquee(opts: {
  container: () => HTMLElement | undefined;
  source: () => string;
}) {
  let startX = 0;
  let startY = 0;
  let active = false;
  // Selection present before the band started — never touched by the band.
  let preexisting = new Set<string>();
  // Rows the band itself added, so it can release them as it shrinks.
  let owned = new Set<string>();

  function itemFromEl(el: Element): SideboardDragAndDropItem {
    return {
      id: el.getAttribute("data-dnd-item")!,
      url: el.getAttribute("data-doc-url") as AutomergeUrl,
      type: el.getAttribute("data-doc-type") ?? "",
      name: (el.textContent ?? "").trim(),
      source: opts.source(),
    };
  }

  function onMouseMove(event: MouseEvent) {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!active) {
      // Small threshold so a plain cmd-click still toggles a single item.
      if (Math.hypot(dx, dy) < 5) return;
      active = true;
    }
    event.preventDefault();

    const left = Math.min(startX, event.clientX);
    const top = Math.min(startY, event.clientY);
    const right = Math.max(startX, event.clientX);
    const bottom = Math.max(startY, event.clientY);

    const container = opts.container();
    if (!container) return;

    const nextOwned = new Set<string>();
    for (const el of container.querySelectorAll("[data-dnd-item]")) {
      if ((el as HTMLElement).offsetParent === null) continue; // hidden row
      const id = el.getAttribute("data-dnd-item");
      if (!id || preexisting.has(id)) continue;
      const r = el.getBoundingClientRect();
      const hit = !(
        r.right < left ||
        r.left > right ||
        r.bottom < top ||
        r.top > bottom
      );
      if (!hit) continue;
      nextOwned.add(id);
      if (!dragstack.has(id)) addToDragstack(id, itemFromEl(el));
    }
    for (const id of owned) {
      if (!nextOwned.has(id)) removeFromDragstack(id);
    }
    owned = nextOwned;
  }

  function onMouseUp() {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    active = false;
    owned = new Set();
    preexisting = new Set();
  }

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    // Don't start a band from the toolbar (filter input / create button).
    if ((event.target as Element).closest(".document-list__toolbar")) return;
    startX = event.clientX;
    startY = event.clientY;
    active = false;
    owned = new Set();
    preexisting = new Set(dragstack.keys());
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  }

  return { onMouseDown };
}
