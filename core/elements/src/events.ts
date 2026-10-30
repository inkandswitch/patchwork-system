import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export interface OpenDocumentEventDetail {
  url: AutomergeUrl;
  toolId?: string;
  title?: string;
  type?: string;
  /**
   * The live path the document was opened at, like a cwd:
   * `<acctHash>/Projects/foo`, each segment `encodeURIComponent`-encoded
   * (see `livePath` in `@inkandswitch/patchwork-filesystem`). The router
   * writes it to `&path=`.
   */
  path?: string;
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

declare global {
  interface ShadowRootEventMap extends ElementEventMap {
    "patchwork:open-document": OpenDocumentEvent;
    "patchwork:mounted": MountedEvent;
    "patchwork:unmounted": UnmountedEvent;
  }
  interface ElementEventMap {
    "patchwork:open-document": OpenDocumentEvent;
    "patchwork:mounted": MountedEvent;
    "patchwork:unmounted": UnmountedEvent;
  }
}

export const openDocument = (
  element: HTMLElement | ShadowRoot,
  url: AutomergeUrl,
  toolId?: string,
  path?: string
) => {
  element.dispatchEvent(new OpenDocumentEvent({ url, toolId, path }));
};
