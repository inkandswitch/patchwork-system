/**
 * Drag-and-drop bridge — delivers a host-side drag (e.g. a document dragged out
 * of the sidebar) into an isolated tool running in the iframe.
 *
 * Direction matters. The navigation bridge runs iframe → host (a tool asks the
 * host to open a document it already knows). This bridge runs the OTHER way,
 * **host → iframe**: the host is disclosing document URLs *into* untrusted tool
 * code. That is exactly the thing the isolation boundary exists to control (see
 * ISOLATION.md, "controlling which automerge URLs the isolated context can
 * learn"), so disclosure here is deliberately scoped:
 *
 *  - Only the patchwork document-drag MIME types are read; arbitrary drag data
 *    is never forwarded.
 *  - Every dragged URL is run through the allowlist gate (`allowlistDrop`),
 *    which denylist-checks it first. A URL that resolves to a sensitive document
 *    (account doc, module settings, tool source) is dropped from the payload and
 *    never crosses — even as text.
 *  - The drag is the user's own gesture, so the surviving URLs are allowlisted
 *    silently (no prompt), the same authorization signal as opening a document.
 *
 * A cross-realm drag is inherently cross-view, so it is always a *copy*
 * (add-link), never a move — which is the correct semantic for dropping a
 * document reference into another document anyway.
 *
 * ## Why an overlay
 *
 * The iframe is cross-origin (opaque origin: `allow-scripts` without
 * `allow-same-origin`). When a host-initiated drag moves over such an iframe the
 * browser routes the drag events *into the iframe's document*, but the iframe's
 * `drop` fires with an EMPTY DataTransfer — the browser blocks the custom drag
 * types cross-origin (Chromium #251718, FilePond #218). So the tool's own drop
 * handler inside the iframe can never see the payload, and the host's listeners
 * on the <iframe> element don't fire over the content region either.
 *
 * The fix is a transparent host-owned overlay raised *on top of* the iframe for
 * the duration of a drag. Because the overlay is a plain host-DOM element, the
 * host receives `dragover`/`drop` with the full (same-origin) DataTransfer. We
 * parse and gate it host-side, then forward only the surviving documents into
 * the iframe over RPC, where they are re-dispatched as a synthetic drop the
 * tool's own handler consumes. The overlay exists ONLY while a drag is active,
 * so it never interferes with normal pointer input.
 *
 * Protocol:
 *   host → iframe:  { type: "drop", formats: Record<string,string>, x, y }
 *   (x, y are iframe-local client coordinates for the drop point.)
 */

import {
  type AutomergeUrl,
  type DocumentId,
  isValidAutomergeUrl,
  isValidDocumentId,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { log } from "../log.js";

// The patchwork document-drag MIME types. Mirrors the sideboard's convention
// (duplicated on purpose across tools — a shared package is a later step). Only
// these are read off the drag; anything else is ignored.
const PATCHWORK_DND = "text/x-patchwork-dnd";
const PATCHWORK_URLS = "text/x-patchwork-urls";
const URI_LIST = "text/uri-list";
const PLAIN = "text/plain";

/** Any patchwork document-drag format present on the drag? */
function isPatchworkDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return (
    dt.types.includes(PATCHWORK_DND) ||
    dt.types.includes(PATCHWORK_URLS) ||
    dt.types.includes(URI_LIST) ||
    dt.types.includes(PLAIN)
  );
}

/** Turn an automerge url or a patchwork web link into a DocumentId, or null.
 *  Mirrors the drop target's `urlToDocId` (codemirror-markdown/embed.ts). */
function urlToDocId(raw: string): DocumentId | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const am = trimmed.match(/automerge:([a-zA-Z0-9]+)/);
  if (am && isValidDocumentId(am[1])) return am[1] as DocumentId;
  const web = trimmed.match(/[#&?]doc=([a-zA-Z0-9]+)/);
  if (web && isValidDocumentId(web[1])) return web[1] as DocumentId;
  return null;
}

/**
 * A structured drag item, as produced by the sideboard on the `text/x-patchwork-dnd`
 * format. We keep only the fields the drop target reads (`url`, `toolId`); every
 * other field (name, type, source, internal ids) is deliberately dropped so no
 * incidental data crosses.
 */
type DndItem = { url: string; toolId?: string };

/**
 * Extract, from a drag's DataTransfer, the set of dragged documents keyed by
 * DocumentId, preserving an explicit `toolId` where the structured format
 * carried one. Reads formats in the same preference order as the drop target.
 */
function extractItems(dt: DataTransfer): Map<DocumentId, { toolId?: string }> {
  const items = new Map<DocumentId, { toolId?: string }>();
  const add = (docId: DocumentId | null, toolId?: string) => {
    if (!docId || items.has(docId)) return;
    items.set(docId, { toolId });
  };

  const dnd = dt.getData(PATCHWORK_DND);
  if (dnd) {
    try {
      const parsed = JSON.parse(dnd) as { items?: DndItem[] };
      for (const item of parsed?.items ?? []) {
        if (item?.url) add(urlToDocId(item.url), item.toolId);
      }
    } catch {
      // fall through to the other formats
    }
  }
  if (items.size > 0) return items;

  const urls = dt.getData(PATCHWORK_URLS);
  if (urls) {
    try {
      const parsed: unknown = JSON.parse(urls);
      if (Array.isArray(parsed)) {
        for (const u of parsed) add(urlToDocId(String(u)));
      }
    } catch {
      // fall through
    }
  }
  if (items.size > 0) return items;

  const text = dt.getData(URI_LIST) || dt.getData(PLAIN);
  if (text) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) continue; // uri-list comments
      add(urlToDocId(line));
    }
  }
  return items;
}

/**
 * Build the forwarded formats from the *surviving* (allowlisted) items only.
 * We reconstruct the format strings from scratch rather than forwarding the raw
 * drag data, so a denylisted or unparseable URL never crosses the boundary even
 * as text. The two structured formats are enough for the drop target — it reads
 * `text/x-patchwork-dnd` first, then `text/x-patchwork-urls`.
 */
function buildForwardedFormats(
  survivors: Array<{ docId: DocumentId; toolId?: string }>
): Record<string, string> {
  const urls = survivors.map(({ docId }) => stringifyAutomergeUrl(docId));
  return {
    [PATCHWORK_DND]: JSON.stringify({
      source: "isolation:drag-drop-bridge",
      items: survivors.map(({ docId, toolId }) => ({
        url: stringifyAutomergeUrl(docId),
        ...(toolId ? { toolId } : {}),
      })),
    }),
    [PATCHWORK_URLS]: JSON.stringify(urls),
  };
}

/**
 * Host-side drag-and-drop bridge.
 *
 * Watches the host document for a patchwork document drag; while one is active,
 * raises a transparent overlay over the iframe so the host (not the cross-origin
 * iframe) receives the drop with its full DataTransfer. On drop the dragged
 * documents are gated and the surviving set is posted into the iframe over RPC,
 * where it is re-dispatched as a synthetic drop the tool's own handler consumes.
 *
 * @param allowlistDrop - gate + disclose one dragged URL. Returns true if the
 *   URL survived (is now allowlisted) and may be forwarded; false if it was
 *   denylisted and must be withheld. Closes over the intermediary allowlist /
 *   denylist (see boot.ts) — this bridge holds no policy of its own.
 */
export function startHostDragDropBridge(
  rpcPort: MessagePort,
  getIframe: () => HTMLIFrameElement | null,
  allowlistDrop: (url: AutomergeUrl) => Promise<boolean>
): () => void {
  // The overlay is created lazily on first drag and reused. It is only in the
  // DOM (and only pointer-catching) while a drag is active, so it never blocks
  // normal input. Positioned to track the iframe exactly. The iframe is fetched
  // lazily (via getIframe) because the bridge is started before createIframe
  // builds the element; it exists by the time any drag can occur.
  let overlay: HTMLDivElement | null = null;

  const positionOverlay = () => {
    const iframeEl = getIframe();
    if (!overlay || !iframeEl) return;
    const rect = iframeEl.getBoundingClientRect();
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };

  const showOverlay = () => {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("data-patchwork-isolation-drop-overlay", "");
      overlay.style.cssText =
        "position: fixed; z-index: 2147483647; background: transparent;";
      overlay.addEventListener("dragover", onOverlayDragOver);
      overlay.addEventListener("drop", onOverlayDrop);
      // A drag that leaves the overlay (back over host chrome, or out of the
      // window) tears it down so it never lingers and blocks input.
      overlay.addEventListener("dragleave", onOverlayDragLeave);
    }
    positionOverlay();
    if (!overlay.isConnected) document.body.appendChild(overlay);
  };

  const hideOverlay = () => {
    overlay?.remove();
  };

  // Detect the start of a drag anywhere over the host page. We do NOT depend on
  // the sideboard's drag signal — any patchwork document drag entering the host
  // document raises the overlay, keeping the platform decoupled from the drag
  // source. `dragenter` bubbles to document, so one listener suffices.
  const onDocDragEnter = (event: DragEvent) => {
    if (!isPatchworkDrag(event.dataTransfer)) return;
    showOverlay();
  };

  const onOverlayDragOver = (event: DragEvent) => {
    if (!isPatchworkDrag(event.dataTransfer)) return;
    // Accept the drag so the browser permits a drop and shows a copy cursor.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const onOverlayDragLeave = (event: DragEvent) => {
    // Only tear down when the pointer actually leaves the overlay (not on the
    // spurious dragleave fired when moving between child nodes — the overlay has
    // none, but relatedTarget null also covers leaving the window).
    if (event.relatedTarget === overlay) return;
    hideOverlay();
  };

  const onOverlayDrop = (event: DragEvent) => {
    const dt = event.dataTransfer;
    // Always tear the overlay down on drop, whatever the payload.
    hideOverlay();
    if (!isPatchworkDrag(dt) || !dt) return;
    event.preventDefault();

    const items = extractItems(dt);
    if (items.size === 0) return;

    const iframeEl = getIframe();
    if (!iframeEl) return;

    // Iframe-local coordinates for the drop point. The overlay is positioned to
    // exactly cover the iframe, so subtracting the iframe's top-left maps the
    // drop's client coords to the iframe's own client coords (unscaled layout).
    const rect = iframeEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Gate every dragged URL before anything crosses. Denylisted URLs are
    // dropped from the payload; survivors are allowlisted (silently — the drag
    // is the user's authorization) so the embed renders without a later prompt.
    void (async () => {
      const survivors: Array<{ docId: DocumentId; toolId?: string }> = [];
      for (const [docId, { toolId }] of items) {
        const url = stringifyAutomergeUrl(docId);
        if (!isValidAutomergeUrl(url)) continue;
        if (await allowlistDrop(url)) {
          survivors.push({ docId, toolId });
        } else {
          log(`drop withheld (denylisted): ${docId}`);
        }
      }
      if (survivors.length === 0) {
        log("drop had no forwardable documents");
        return;
      }
      log(`forwarding drop of ${survivors.length} document(s)`);
      rpcPort.postMessage({
        type: "drop",
        formats: buildForwardedFormats(survivors),
        x,
        y,
      });
    })();
  };

  // Keep the overlay aligned if the layout shifts mid-drag.
  const onScrollOrResize = () => positionOverlay();

  document.addEventListener("dragenter", onDocDragEnter, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);

  return () => {
    document.removeEventListener("dragenter", onDocDragEnter, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    hideOverlay();
    overlay = null;
  };
}
