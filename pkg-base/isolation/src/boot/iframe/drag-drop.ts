/**
 * Drag-and-drop, inside the iframe. Runs in the sandbox: defined at module scope
 * so tsc checks it, serialized into the srcdoc by ../host/srcdoc.ts, and called
 * from `boot()`.
 *
 * A host-forwarded drag (see bridges/drag-drop-bridge.ts) arrives as a `drop`
 * RPC message carrying the already-gated, already-filtered document formats plus
 * the iframe-local drop coordinates. Native drag events can't cross into a
 * cross-origin iframe with any usable data, so the host reconstructs the drop
 * over RPC and this module re-dispatches it as a *synthetic* DOM drop — letting
 * an isolated tool's own drop handler (e.g. codemirror-markdown's) consume it
 * unchanged. Tool-agnostic: nothing here knows about any particular tool.
 *
 * A cross-realm drop is always a copy (`effectAllowed`/`dropEffect` = "copy") —
 * the host-side move-vs-link identity check can't span realms, and embedding a
 * document reference is the correct semantic anyway.
 */

import type { IframeLog } from "./types.js";

export interface DragDrop {
  /**
   * Handle an inbound RPC message. Returns true if it was a `drop` (and
   * re-dispatched a synthetic drop), false otherwise — letting the caller route
   * the message to another consumer.
   */
  handle(event: MessageEvent): boolean;
}

/** Create the iframe-side drag-and-drop consumer. */
export function createDragDrop(log: IframeLog): DragDrop {
  function handle(event: MessageEvent): boolean {
    if (event.data?.type !== "drop") return false;

    const { formats, x, y } = event.data as {
      formats: Record<string, string>;
      x: number;
      y: number;
    };

    // The element under the drop point is where the tool's handler lives (it
    // typically registers on a content element and reads via bubbling).
    // Dispatching here mirrors a real drop's target so target-membership checks
    // (e.g. CodeMirror's `eventBelongsToEditor`) pass.
    const target = document.elementFromPoint(x, y);
    if (!target) {
      log("synthetic drop: no element at drop point");
      return true;
    }

    const dt = new DataTransfer();
    for (const [type, data] of Object.entries(formats)) {
      try {
        dt.setData(type, data);
      } catch {
        // Some environments guard setData outside a real drag; skip that format.
      }
    }
    dt.effectAllowed = "copy";
    dt.dropEffect = "copy";

    const init: DragEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      dataTransfer: dt,
    };
    // Fire dragover then drop: some drop targets only arm on a preceding
    // dragover (and it lets them set dropEffect), matching a real sequence.
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
    log("synthetic drop dispatched");
    return true;
  }

  return { handle };
}
