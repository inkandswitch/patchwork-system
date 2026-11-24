import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export interface OpenDocumentEventDetail {
  url: AutomergeUrl;
  toolId?: string;
  title?: string;
  type?: string;
}

export class OpenDocumentEvent extends CustomEvent<OpenDocumentEventDetail> {
  constructor(detail: OpenDocumentEventDetail) {
    super("patchwork:open-document", {
      detail,
      composed: true,
      bubbles: true,
    });
  }
}

export type MountedEventDetail =
  { url: AutomergeUrl; toolId: string } | { componentId: string };

export class MountedEvent extends CustomEvent<MountedEventDetail> {
  constructor(detail: MountedEventDetail) {
    super("patchwork:mounted", {
      detail,
      composed: true,
      bubbles: true,
    });
  }
}

export type UnmountedEventDetail = MountedEventDetail;

export class UnmountedEvent extends CustomEvent<UnmountedEventDetail> {
  constructor(detail: UnmountedEventDetail) {
    super("patchwork:unmounted", {
      detail,
      composed: true,
      bubbles: true,
    });
  }
}

export interface NoToolEventDetail {
  url: AutomergeUrl;
}

/**
 * The view put a card up in place of a tool: it can't show the doc, for now
 * or for good. Sent so whatever waits on `patchwork:mounted` (a sidebar that
 * holds back until the main doc is up, say) doesn't wait on a doc that isn't
 * coming.
 */
export class NoToolEvent extends CustomEvent<NoToolEventDetail> {
  constructor(detail: NoToolEventDetail) {
    super("patchwork:no-tool", {
      detail,
      composed: true,
      bubbles: true,
    });
  }
}

declare global {
  interface ShadowRootEventMap extends ElementEventMap {
    "patchwork:open-document": OpenDocumentEvent;
    "patchwork:mounted": MountedEvent;
    "patchwork:unmounted": UnmountedEvent;
    "patchwork:no-tool": NoToolEvent;
  }
  interface ElementEventMap {
    "patchwork:open-document": OpenDocumentEvent;
    "patchwork:mounted": MountedEvent;
    "patchwork:unmounted": UnmountedEvent;
    "patchwork:no-tool": NoToolEvent;
  }
}

export const openDocument = (
  element: HTMLElement | ShadowRoot,
  url: AutomergeUrl,
  toolId?: string
) => {
  element.dispatchEvent(new OpenDocumentEvent({ url, toolId }));
};
