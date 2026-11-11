import { createEffect, onCleanup, type JSX } from "solid-js";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import {
  type SideboardDragAndDropItem,
  dragstack,
  addToDragstack,
  removeFromDragstack,
  clearDragstack,
  setDragging,
  clearDragSourceItems,
  setDropTarget,
  isAbove,
  clearDropTarget,
  copyMode,
  setCopyMode,
  setDragOriginView,
  rowSpot,
} from "../dnd/dnd.ts";
import { setMenuTarget } from "../state.ts";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { dropInto } from "../dnd/drop-into.ts";
import { startDrag } from "../dnd/drag-start.ts";
import { createDragOut } from "../dnd/drag-out.ts";
import { createHoverTimer } from "../lib/hover-timer.ts";
import { revealSelectedRow } from "./reveal.ts";

// Spring-loading: while a drag is in progress, hovering it over a document
// row for a moment opens that document in the main view *without ending the
// drag*, so you can then drop the payload at a precise spot inside the now-
// open document. Folders are excluded (they open inline instead, see
// folder.tsx), and the rows being dragged never spring-load themselves.
const SPRING_LOAD_MS = 1500;

export default function Item(props: {
  "aria-label": string;
  id: string;
  url: AutomergeUrl;
  name: string;
  type: string;
  pressed: boolean;
  children: JSX.Element;
  openWith(toolId?: string): void;
  startRenaming(): void;
  remove(): void;
  element: PatchworkViewElement;
  repo: Repo;
  rootFolderHandle: DocHandle<FolderDoc>;
  parentFolderHandle?: DocHandle<FolderDoc>;
  itemIndex?: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /** open this folder (for a new-doc drop into it) */
  expand?: () => void;
  /** when set (i.e. this item is a folder), enables a "Create" submenu that
   * makes a new doc of the picked datatype inside this folder */
  createInside?(datatype: Plugin<DatatypeDescription>): void;
}) {
  let row: HTMLDivElement | undefined;
  const isFolder = () => props.type === "folder";
  const parentUrl = () =>
    (props.parentFolderHandle ?? props.rootFolderHandle).url;

  const dragOut = createDragOut(props);

  createEffect((prev) => {
    if (props.pressed && !prev && row) revealSelectedRow(row);
    return props.pressed;
  });

  const dnd = (): SideboardDragAndDropItem => ({
    id: props.id,
    type: props.type,
    url: props.url,
    name: props.name,
    source: props.element.toolId!,
  });

  const springLoad = createHoverTimer(SPRING_LOAD_MS, () => {
    row?.removeAttribute("data-dnd-springload");
    props.openWith();
  });
  function startSpringLoad() {
    if (isFolder() || dragstack.has(props.id)) return;
    if (springLoad.start()) row?.setAttribute("data-dnd-springload", "");
  }
  function stopSpringLoad() {
    springLoad.stop();
    row?.removeAttribute("data-dnd-springload");
  }
  onCleanup(stopSpringLoad);

  // The context menu itself lives in the panel (see item-menu.tsx) so that a
  // tree of thousands of rows doesn't carry thousands of menus.
  function openMenu(x: number, y: number) {
    setMenuTarget({
      x,
      y,
      element: row!,
      id: props.id,
      url: props.url,
      name: props.name,
      type: props.type,
      openWith: props.openWith,
      startRenaming: props.startRenaming,
      remove: props.remove,
      createInside: props.createInside,
    });
  }

  let longPress: ReturnType<typeof setTimeout> | undefined;
  const cancelLongPress = () => clearTimeout(longPress);
  onCleanup(cancelLongPress);

  function open() {
    clearDragstack();
    props.openWith();
  }

  return (
    <div
      ref={row}
      role="treeitem"
      tabindex="-1"
      aria-label={props["aria-label"]}
      aria-haspopup="menu"
      aria-selected={props.pressed ? "true" : undefined}
      aria-expanded={isFolder() ? !!props.isExpanded : undefined}
      class="popmenu__trigger document-list-item"
      draggable="true"
      data-dnd-item={props.id}
      data-dnd-parent={parentUrl()}
      data-dnd-index={props.itemIndex}
      data-doc-url={props.url}
      data-doc-type={props.type}
      on:contextmenu={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      }}
      onpointerdown={(event: PointerEvent) => {
        if (event.pointerType === "touch" || event.pointerType === "pen") {
          longPress = setTimeout(
            () => openMenu(event.clientX, event.clientY),
            700
          );
        }
      }}
      onpointerup={cancelLongPress}
      onpointercancel={cancelLongPress}
      ondragstart={(event: DragEvent) => {
        cancelLongPress();
        startDrag(event, dnd(), props.element, dragOut);
      }}
      ondrag={(event: DragEvent) => {
        // Update copy mode if Alt key state changes during drag
        if (event.altKey !== copyMode()) setCopyMode(event.altKey);
      }}
      ondragend={() => {
        stopSpringLoad();
        clearDropTarget();
        clearDragSourceItems();
        clearDragstack();
        setCopyMode(false);
        setDragOriginView(null);
        setDragging(false);
      }}
      ondragover={(event: DragEvent) => {
        event.preventDefault();
        event.dataTransfer!.dropEffect = copyMode() ? "copy" : "move";

        const rect = row!.getBoundingClientRect();
        let position: "above" | "below" | "inside";
        if (isFolder()) {
          // three zones: top quarter above, bottom quarter below, middle inside
          const at = (event.clientY - rect.top) / rect.height;
          position = at < 0.25 ? "above" : at > 0.75 ? "below" : "inside";
        } else {
          position = isAbove(event.clientY, row!) ? "above" : "below";
        }
        // "inside" bubbles on to the folder, which opens itself on a hold
        if (position !== "inside") event.stopPropagation();

        setDropTarget(
          rowSpot(
            {
              id: props.id,
              url: props.url,
              parentUrl: parentUrl(),
              index: props.itemIndex ?? 0,
            },
            position
          )
        );
        startSpringLoad();
      }}
      ondragleave={(event: DragEvent) => {
        // Only clear if we're actually leaving (not entering a child)
        const related = event.relatedTarget as Element;
        if (!related || !row!.contains(related)) {
          stopSpringLoad();
          clearDropTarget();
        }
      }}
      ondrop={(event: DragEvent) => {
        // Rows handle every drop on them themselves, "inside" a folder too:
        // relying on it bubbling to the folder wrapper is fragile.
        event.preventDefault();
        event.stopPropagation();
        stopSpringLoad();
        dropInto(event, {
          repo: props.repo,
          rootFolderHandle: props.rootFolderHandle,
          element: props.element,
          expand: props.expand,
        });
      }}
      onMouseDown={(event: MouseEvent) => {
        // Warm up file metadata so a subsequent drag can export to the OS.
        dragOut.prefetch();
        if (event.ctrlKey || event.metaKey) {
          if (dragstack.has(props.id)) {
            removeFromDragstack(props.id);
          } else {
            addToDragstack(props.id, dnd());
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        } else if (!dragstack.has(props.id)) {
          clearDragstack();
        }
      }}
      on:click={(event: MouseEvent) => {
        if (event.ctrlKey || event.metaKey) return;
        const target = event.target as Element;
        if (target.closest(".document-list-folder__toggle, .create-new-button, input")) {
          return;
        }
        open();
      }}
      on:dblclick={(event: MouseEvent) => {
        if ((event.target as Element).closest("input")) return;
        props.startRenaming();
      }}
      onkeydown={(event: KeyboardEvent) => {
        // keys typed into the rename box are the rename box's
        if (event.target !== row) return;
        const plain = !(event.altKey || event.shiftKey || event.metaKey || event.ctrlKey);

        if (plain && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open();
          return;
        }

        // Right opens a closed folder, Left closes an open one. Anything else
        // (Right on an open folder, Left on a closed one) moves focus, in
        // tree-nav.ts.
        if (plain && isFolder() && props.onToggleExpand) {
          if (
            (event.key === "ArrowRight" && !props.isExpanded) ||
            (event.key === "ArrowLeft" && props.isExpanded)
          ) {
            event.preventDefault();
            props.onToggleExpand();
            return;
          }
        }

        // Context menu shortcut
        if (
          event.key == "Enter" &&
          event.ctrlKey &&
          !(event.altKey || event.shiftKey || event.metaKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const box = row!.getBoundingClientRect();
          openMenu(box.x + 10, box.y + box.height - 10);
        }
      }}
    >
      {props.children}
    </div>
  );
}
