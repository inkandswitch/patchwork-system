import { onCleanup, onMount } from "solid-js";

export type SidebarSide = "left" | "right";

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 720;
/** Drag a sidebar narrower than this and it snaps closed (Things-3 style), and
 * re-opens once dragged back out past it. */
export const AUTO_CLOSE_WIDTH = 120;
/** Pointer travel (px) before a press on the handle counts as a drag. */
export const DRAG_THRESHOLD = 3;

interface UseSidebarResizeParams {
  isCollapsed: () => boolean;
  setCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void;
  setWidth: (width: number) => void;
}

/**
 * Resize and toggle interactions for ONE sidebar. Whoever owns a sidebar's
 * width/collapsed state calls this once for it: the host for the left sidebar,
 * `DocumentAreaRoot` for the right (context) one.
 */
export function useSidebarResize(
  side: SidebarSide,
  { isCollapsed, setCollapsed, setWidth }: UseSidebarResizeParams
) {
  // Non-reactive refs for drag state
  let isResizing = false;
  let dragStartPos: { x: number; y: number } | null = null;
  let hasDragged = false;
  // The last *open* width applied during the live drag (null while the drag is
  // previewing a collapse). Read on release to decide whether to spring back.
  let lastDragWidth: number | null = null;

  // Apply a candidate width from a live drag. The panel tracks the pointer to
  // *any* size (Things 3 / nextaction feel) - it is allowed below the minimum
  // so you can see it shrink past the limit; the over-shrink is rejected later,
  // on release (see `settleDrag`). Below the auto-close threshold it snaps shut
  // live (so it reads as "let go here and it stays closed", and so the collapsed
  // 1px strip can be grabbed and dragged back open).
  const applyDragWidth = (raw: number) => {
    if (raw < AUTO_CLOSE_WIDTH) {
      if (!isCollapsed()) setCollapsed(true);
      lastDragWidth = null;
      return;
    }
    if (isCollapsed()) setCollapsed(false);
    const w = Math.min(MAX_SIDEBAR_WIDTH, raw);
    setWidth(w);
    lastDragWidth = w;
  };

  // Decide the resting state when a drag ends. The width transition is live
  // again by now (the resizing flag was cleared in `endDrag`), so any width we
  // set here animates: if the drag finished too small (in the [auto-close, min)
  // band) the panel springs back out to the minimum; if it finished below
  // auto-close it already snapped collapsed during the drag, so we leave it.
  const settleDrag = () => {
    if (isCollapsed()) return;
    if (lastDragWidth !== null && lastDragWidth < MIN_SIDEBAR_WIDTH) {
      setWidth(MIN_SIDEBAR_WIDTH);
    }
  };

  // A full-window overlay, added the moment a real drag begins. It keeps every
  // pointer event (and the resize cursor) on the parent document even as the
  // cursor passes over a tool iframe - otherwise the iframe swallows the
  // mousemove/mouseup and the drag can never end ("you can't let go"). It's
  // added lazily (not on mousedown) so a plain click still lands on the handle
  // and toggles collapse.
  let dragOverlay: HTMLDivElement | null = null;

  const beginDragVisuals = () => {
    // suppress the width transition so the panel tracks the pointer 1:1, and tag
    // which side is dragging so the divider glow can extend up through the top
    // bar on that side (see `[data-sidebar-resizing]` rules in the stylesheet).
    document.body.setAttribute("data-sidebar-resizing", side);
    dragOverlay = document.createElement("div");
    dragOverlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;";
    document.body.appendChild(dragOverlay);
  };

  const endDrag = () => {
    isResizing = false;
    dragStartPos = null;
    document.body.style.userSelect = "";
    document.body.removeAttribute("data-sidebar-resizing");
    dragOverlay?.remove();
    dragOverlay = null;
  };

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    dragStartPos = { x: e.clientX, y: e.clientY };
    hasDragged = false;
    lastDragWidth = null;
    isResizing = true;
    document.body.style.userSelect = "none";
  };

  const handleMouseUp = () => {
    // Capture the drag state before endDrag() clears it, then resolve the
    // resting size with the width transition restored so spring-backs animate.
    const wasResizing = isResizing;
    const dragged = hasDragged;
    endDrag();
    if (wasResizing && dragged) settleDrag();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing || !dragStartPos) return;

    // Once past the threshold this is a drag: drop the overlay in now, before
    // the cursor can reach any iframe, and suppress the width transition.
    const deltaX = Math.abs(e.clientX - dragStartPos.x);
    const deltaY = Math.abs(e.clientY - dragStartPos.y);
    if (!hasDragged && (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD)) {
      hasDragged = true;
      beginDragVisuals();
    }

    applyDragWidth(
      side === "left" ? e.clientX : window.innerWidth - e.clientX
    );
  };

  const handleToggleClick = (e: MouseEvent) => {
    // Only toggle if we didn't drag
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
      // Reset the flag for next interaction
      hasDragged = false;
      return;
    }
    setCollapsed((prev) => !prev);
  };

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Reset body styles if component unmounts during drag
      if (isResizing) {
        endDrag();
      }
    });
  });

  return {
    handleMouseDown,
    handleToggleClick,
  };
}
