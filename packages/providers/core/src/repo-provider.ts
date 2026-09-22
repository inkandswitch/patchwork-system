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
 * Defines the `<repo-provider>` custom element.
 *
 * It carries the realm-local repo on its `.repo` property and acts as the
 * root-level fallback answerer for `repo:handle-descriptor`. Sitting above every
 * `<patchwork-view>`, it resolves a requested url to itself (no clone) so any
 * view rendered outside a remapper (e.g. a draft overlay) still resolves and
 * the overlay shim's `find` never hangs. A nearer remapper answers
 * `{ url, cloneUrl? }` and `stopPropagation()`s first, so this only fires when
 * nothing else claims the subscription.
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
