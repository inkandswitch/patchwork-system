import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";

import { accept, type SubscribeEvent } from "./index.js";
import type { DocHandleDescriptor } from "./overlay-repo.js";

declare global {
  interface HTMLElementTagNameMap {
    "repo-provider": RepoProviderElement;
  }
}

export interface RepoProviderElement extends HTMLElement {
  repo?: Repo;
}

/**
 * Defines the `<repo-provider>` custom element. It carries the realm's repo on
 * `.repo`, and answers `repo:handle-descriptor` with the url it was asked
 * about, so a view with no remapper above it still resolves instead of
 * hanging. A nearer remapper answers first and stops the event.
 */
export function registerRepoProviderElement(
  repo: Repo,
  name = "repo-provider"
): void {
  if (customElements.get(name)) return;
  customElements.define(
    name,
    class extends HTMLElement implements RepoProviderElement {
      repo: Repo = repo;

      constructor() {
        super();
        this.addEventListener(
          "patchwork:subscribe",
          (event: SubscribeEvent) => {
            if (event.detail.selector.type !== "repo:handle-descriptor") return;
            const url = event.detail?.selector?.url as AutomergeUrl | undefined;
            if (!url) return;
            accept<DocHandleDescriptor>(event, (respond) => {
              respond({ url });
            });
          }
        );
      }

      connectedCallback() {
        if (!this.style.display) this.style.display = "contents";
      }
    }
  );
}
