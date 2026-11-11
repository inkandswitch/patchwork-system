/**
 * Navigation bridge — forwards `patchwork:open-document` events from the
 * iframe to the host element so that tools can trigger navigation.
 *
 * Navigation is gated by the intermediary's allowlist: allowlisted
 * documents navigate immediately, others require user confirmation.
 *
 * Protocol:
 *   iframe → host:  { type: "open-document", detail: OpenDocumentEventDetail }
 */

import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { OpenDocumentEventDetail } from "../../events.js";
import { log } from "../log.js";

/**
 * Host-side navigation bridge.
 *
 * Listens on the RPC port for `open-document` messages from the iframe
 * and re-dispatches them as `patchwork:open-document` CustomEvents on
 * the host element.
 *
 * Navigation is gated by an `isAllowed` callback that checks the
 * intermediary repo's allowlist. Allowlisted documents navigate
 * immediately; non-allowlisted documents require user confirmation.
 */
export function startHostNavigationBridge(
  rpcPort: MessagePort,
  hostElement: HTMLElement,
  isAllowed: (url: AutomergeUrl) => boolean
): () => void {
  const onMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg?.type !== "open-document") return;

    const detail = msg.detail as OpenDocumentEventDetail;

    if (!isAllowed(detail.url)) {
      log(`navigation prompted: ${detail.url}`);
      const title = detail.title ?? "Unknown";
      const type = detail.type ?? "unknown";
      const allowed = window.confirm(
        `A tool wants to open a document:\n\n` +
          `Title: ${title}\n` +
          `Type: ${type}\n` +
          `URL: ${detail.url}\n\n` +
          `Allow navigation?`
      );
      if (!allowed) {
        log(`navigation denied: ${detail.url}`);
        return;
      }
    } else {
      log(`navigation allowed: ${detail.url}`);
    }

    hostElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  };

  rpcPort.addEventListener("message", onMessage);

  return () => {
    rpcPort.removeEventListener("message", onMessage);
  };
}
