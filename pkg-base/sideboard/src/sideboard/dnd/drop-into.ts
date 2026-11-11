import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import {
  clearDropTarget,
  copyMode,
  getDropTarget,
  isNewDocDrag,
  isSameDragOriginView,
  type DropSpot,
} from "./dnd.ts";
import { DropError, executeDrop, type Landed } from "./operations.ts";
import { getDndPayload } from "./payload.ts";
import { handleFilesDrop } from "../document-list/file-drop.ts";
import { setDropError, setPendingNewDoc } from "../state.ts";
import { log } from "./debug.ts";

const ERROR_MS = 5000;
const FLASH_MS = 700;

/**
 * Finish a drop at the spot the drop line is showing (getDropTarget), so where
 * it lands is always what the person was looking at. Handles all three kinds of
 * drag: files from the OS, documents, and the "new document" button. A failure
 * is shown in the panel; what landed flashes.
 */
export async function dropInto(
  event: DragEvent,
  ctx: {
    repo: Repo;
    rootFolderHandle: DocHandle<FolderDoc>;
    element: object;
    /** open the folder the spot is inside, so a new-doc placeholder shows */
    expand?(): void;
  }
) {
  const spot = getDropTarget();
  clearDropTarget();
  if (!spot) return;

  // Read everything off the event now: the browser empties dataTransfer as
  // soon as this handler returns, and the rest of this function awaits.
  const newDoc = isNewDocDrag(event);
  const files = [...(event.dataTransfer?.files ?? [])];
  const payload = files.length ? null : getDndPayload(event);
  const sameView = isSameDragOriginView(ctx.element);
  const copy = copyMode();

  if (newDoc) {
    if (spot.position === "inside") ctx.expand?.();
    setPendingNewDoc({ containerUrl: spot.folderUrl, index: spot.index });
    return;
  }

  try {
    if (files.length) {
      const folder = await folderFor(ctx, spot);
      const { landed, failed } = await handleFilesDrop(
        files,
        folder,
        ctx.repo,
        spot.index
      );
      flashLanded(landed);
      if (failed.length) {
        throw new DropError(`Couldn't add ${failed.join(", ")}.`);
      }
      return;
    }

    if (!payload) {
      log("No dnd data in drop event. types:", event.dataTransfer?.types);
      throw new DropError("That isn't something the list can hold.");
    }

    const landed = await executeDrop(
      {
        draggedIds: payload.items.map((item) => item.id ?? item.url),
        draggedUrls: payload.items.map((item) => item.url),
        draggedItems: payload.items,
        sourceToolId: payload.source,
        copyMode: copy,
      },
      spot,
      ctx.repo,
      ctx.rootFolderHandle,
      sameView
    );
    if (landed) flashLanded(landed);
  } catch (error) {
    log("Drop failed:", error);
    showDropError(
      ctx.element,
      error instanceof DropError ? error.message : "That drop didn't work."
    );
  }
}

async function folderFor(
  ctx: { repo: Repo; rootFolderHandle: DocHandle<FolderDoc> },
  spot: DropSpot
) {
  if (spot.folderUrl === ctx.rootFolderHandle.url) return ctx.rootFolderHandle;
  try {
    return await ctx.repo.find<FolderDoc>(spot.folderUrl);
  } catch {
    throw new DropError("Couldn't open the folder to drop into.");
  }
}

let errorTimer: ReturnType<typeof setTimeout> | undefined;
export function showDropError(element: object, message: string) {
  clearTimeout(errorTimer);
  setDropError({ element, message });
  errorTimer = setTimeout(() => setDropError(null), ERROR_MS);
}

function landedSelector({ folderUrl, index, url }: Landed) {
  return (
    `[data-dnd-parent="${CSS.escape(folderUrl)}"]` +
    `[data-dnd-index="${index}"]` +
    `[data-doc-url="${CSS.escape(url)}"]`
  );
}

/**
 * Flash the rows that a drop put somewhere, found by the folder, index and url
 * the change reported. Rows can take a few frames to mount (big lists stream
 * in), so look for a little while. If they never show up because their folder
 * is closed, flash the folder instead.
 */
export function flashLanded(landed: Landed[], frames = 10) {
  if (!landed.length) return;
  const selector = landed.map(landedSelector).join(",");
  requestAnimationFrame(function look() {
    const rows = document.querySelectorAll<HTMLElement>(selector);
    if (rows.length < landed.length && frames-- > 0) {
      requestAnimationFrame(look);
      return;
    }
    if (rows.length) {
      rows.forEach(flash);
      return;
    }
    const folders = [...new Set(landed.map((l) => l.folderUrl))];
    for (const url of folders) {
      document
        .querySelectorAll<HTMLElement>(
          `[data-dnd-item="${CSS.escape(url)}"]`
        )
        .forEach(flash);
    }
  });
}

function flash(row: HTMLElement) {
  row.removeAttribute("data-dnd-landed");
  void row.offsetWidth; // restart the animation if it's already running
  row.setAttribute("data-dnd-landed", "");
  setTimeout(() => row.removeAttribute("data-dnd-landed"), FLASH_MS);
}
