import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";

/**
 * Asked for by anything that wants a doc in the sidebar (the "Add to sidebar"
 * titlebar button, say). It bubbles and is composed, so whatever frame is
 * around the asker can claim it: call `preventDefault()` and hand the work to
 * `detail.respondWith`. Unclaimed, the asker does it itself.
 */
export const ADD_TO_SIDEBAR_EVENT = "patchwork:add-to-sidebar";

export type DocLink = { url: AutomergeUrl; name: string; type: string };

export type AddToSidebarDetail = {
  url: AutomergeUrl;
  name?: string;
  type?: string;
  respondWith?(work: Promise<unknown>): void;
};

type FolderLike = { docs?: DocLink[] };

/**
 * Put `link` first in the folder. A doc that's already there is lifted to the
 * top, keeping its own name, rather than added twice.
 */
export function putAtTop(folder: FolderLike, link: DocLink) {
  if (!folder.docs) folder.docs = [];
  const docs = folder.docs;
  const at = docs.findIndex((existing) => existing.url === link.url);
  if (at === 0) return;
  if (at > 0) {
    const { name, type } = docs[at];
    docs.splice(at, 1);
    docs.unshift({ url: link.url, name, type });
    return;
  }
  docs.unshift({ url: link.url, name: link.name, type: link.type });
}

/** Resolves with pick(doc) once it's something. */
function when<T, R>(
  handle: DocHandle<T>,
  pick: (doc: T) => R | undefined
): Promise<R> {
  return new Promise((resolve) => {
    const check = () => {
      const doc = handle.doc();
      const picked = doc && pick(doc);
      if (!picked) return;
      handle.off("change", check);
      resolve(picked);
    };
    handle.on("change", check);
    check();
  });
}

/**
 * Answer `patchwork:add-to-sidebar` events from inside `element` by putting the
 * doc at the top of the account's root folder (what the sidebar's document list
 * shows). Uses the frame's own repo, so a request from inside a draft overlay
 * still lands in the real sidebar, not a draft of it.
 */
export function handleAddToSidebar<T extends { rootFolderUrl?: AutomergeUrl }>(
  element: HTMLElement,
  repo: Repo,
  accountHandle: DocHandle<T>
) {
  const onAdd = (event: Event) => {
    const detail = (event as CustomEvent<AddToSidebarDetail>).detail;
    if (!detail?.url) return;
    event.preventDefault();
    event.stopPropagation();

    const work = (async () => {
      const rootFolderUrl = await when(accountHandle, (doc) => doc.rootFolderUrl);
      const rootFolder = await repo.find<FolderLike>(rootFolderUrl);
      rootFolder.change((folder) =>
        putAtTop(folder, {
          url: detail.url,
          name: detail.name || "Untitled",
          type: detail.type || "unknown",
        })
      );
    })();
    work.catch((error) =>
      console.error("threepane: couldn't add to sidebar", error)
    );
    detail.respondWith?.(work);
  };

  element.addEventListener(ADD_TO_SIDEBAR_EVENT, onAdd);
  return () => element.removeEventListener(ADD_TO_SIDEBAR_EVENT, onAdd);
}
