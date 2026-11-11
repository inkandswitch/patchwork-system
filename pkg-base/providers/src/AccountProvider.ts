import { type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";

const CONTACT_SELECTOR = "patchwork:contact";

// Only the slice of the account doc this provider reads.
type AccountDocLike = {
  contactUrl?: AutomergeUrl;
};

// Answers `patchwork:contact` subscriptions with the `AutomergeUrl` of the
// current user's contact doc, holding the emission until `contactUrl` is set.
export const AccountProvider = (element: PatchworkViewElement) => {
  const onSubscribe = (event: SubscribeEvent) => {
    if (event.detail.selector.type !== CONTACT_SELECTOR) return;
    accept<AutomergeUrl>(event, (respond) => {
      let canceled = false;

      const view = element.closest<HTMLElement>("patchwork-view") ?? element;
      const accountDocUrl = view.getAttribute("doc-url") as AutomergeUrl | null;
      if (!accountDocUrl) {
        console.warn(
          "[providers/account] no doc-url on enclosing view; cannot resolve contact doc"
        );
        return;
      }

      const repo = element.repo;

      void repo
        .find<AccountDocLike>(accountDocUrl)
        .then((accountDocHandle) => waitForContactUrl(accountDocHandle))
        .then((url) => {
          if (canceled || !url) return;
          respond(url);
        });

      return () => {
        canceled = true;
      };
    });
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
  };
};

// Read `contactUrl` off the account doc, waiting for it to appear if it
// isn't there yet.
function waitForContactUrl(
  accountDocHandle: DocHandle<AccountDocLike>
): AutomergeUrl | Promise<AutomergeUrl> {
  const immediate = accountDocHandle.doc()?.contactUrl;
  if (immediate) return immediate;

  return new Promise<AutomergeUrl>((resolve) => {
    const check = () => {
      const url = accountDocHandle.doc()?.contactUrl;
      if (!url) return;
      accountDocHandle.off("change", check);
      resolve(url);
    };
    accountDocHandle.on("change", check);
  });
}
