import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";

export function createOpenEvent(detail: OpenDocumentEventDetail) {
  const openEvent = new CustomEvent("patchwork:open-document", {
    detail,
    bubbles: true,
    composed: true,
  });
  return openEvent;
}
