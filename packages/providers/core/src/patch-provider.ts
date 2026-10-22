import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";

import { accept, subscribe, type SubscribeEvent } from "./index.js";
import type { DocHandleDescriptor } from "./overlay-repo.js";
import type { PatchDoc } from "./patch-layers.js";

// The part of a folder doc this reads: its links, each link's type, and
// whether it's switched off.
type PatchFolder = {
  docs?: { url?: AutomergeUrl; type?: string; off?: boolean }[];
};

export type PatchProviderOptions = {
  repo: Repo;
  /**
   * A folder doc; its links of type `"patch"` are the patches laid here,
   * except those marked `off: true`, which keep their place in the stack. May
   * be a promise, for a folder that's still being made: subscriptions are
   * claimed straight away and answered once it's known.
   */
  folder: AutomergeUrl | Promise<AutomergeUrl>;
};

/**
 * Lay the patch docs in a folder over every document resolved beneath
 * `element`. Answers `repo:handle-descriptor` by asking its own ancestors
 * first and putting the folder's patches for that document in front of
 * whatever layers they gave, so it stacks over drafts and other remappers
 * rather than hiding them. Later links in the folder are nearer the front.
 *
 * Follows the folder and every patch doc in it live: adding, removing or
 * retargeting a patch re-answers the subscriptions it touches, and the
 * overlay repo re-lays them in place. The first answer waits for the folder
 * to load, so a patched document never flashes unpatched.
 *
 * Returns a teardown.
 */
export function providePatchLayers(
  element: HTMLElement,
  { repo, folder }: PatchProviderOptions
): () => void {
  let disposed = false;
  // The folder's patch docs by the document they patch, back first.
  let index = new Map<DocumentId, AutomergeUrl[]>();
  const patchHandles = new Map<AutomergeUrl, DocHandle<PatchDoc>>();
  // Every live subscription, by the document it asked about.
  const live = new Map<DocumentId, Set<() => void>>();

  // The folder's patch links, in folder order.
  let links: AutomergeUrl[] = [];

  let folderHandle: DocHandle<PatchFolder> | undefined;
  const ready = Promise.resolve(folder).then(async (url) => {
    const handle = await repo.find<PatchFolder>(url);
    if (disposed) return;
    folderHandle = handle;
    handle.on("change", reindex);
    await reindex();
  });
  ready.catch((err) =>
    console.error(`[patchwork-providers] patch folder unavailable:`, err)
  );

  async function reindex() {
    links = (folderHandle?.doc()?.docs ?? [])
      .filter(
        (link) =>
          link.type === "patch" && !link.off && isValidAutomergeUrl(link.url)
      )
      .map((link) => link.url!);

    for (const url of links) {
      if (patchHandles.has(url)) continue;
      try {
        const handle = await repo.find<PatchDoc>(url);
        if (disposed) return;
        if (patchHandles.has(url)) continue;
        patchHandles.set(url, handle);
        handle.on("change", rebuild);
      } catch (err) {
        console.warn(`[patchwork-providers] patch ${url} unavailable:`, err);
      }
    }
    for (const [url, handle] of patchHandles) {
      if (links.includes(url)) continue;
      handle.off("change", rebuild);
      patchHandles.delete(url);
    }
    rebuild();
  }

  // Re-read which document each patch is on, and re-answer every
  // subscription whose layers that changed.
  function rebuild() {
    if (disposed) return;
    const next = new Map<DocumentId, AutomergeUrl[]>();
    for (const url of links) {
      const on = patchHandles.get(url)?.doc()?.on;
      if (!on || !isValidAutomergeUrl(on)) continue;
      const { documentId } = parseAutomergeUrl(on);
      const list = next.get(documentId) ?? [];
      list.push(url);
      next.set(documentId, list);
    }
    const before = index;
    index = next;
    for (const [documentId, sends] of live) {
      if (sameList(before.get(documentId), next.get(documentId))) continue;
      for (const send of sends) send();
    }
  }

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector;
    if (selector.type !== "repo:handle-descriptor") return;
    const url = selector.url as AutomergeUrl | undefined;
    if (!url || !isValidAutomergeUrl(url)) return;
    const { documentId } = parseAutomergeUrl(url);

    accept<DocHandleDescriptor>(event, (respond) => {
      let upstream: DocHandleDescriptor | undefined;
      let loaded = false;
      const send = () => {
        if (!upstream || !loaded || disposed) return;
        const own = [...(index.get(documentId) ?? [])].reverse();
        if (own.length === 0) return respond(upstream);
        respond({
          ...upstream,
          layers: [...own, ...(upstream.layers ?? [])],
        });
      };

      let sends = live.get(documentId);
      if (!sends) {
        sends = new Set();
        live.set(documentId, sends);
      }
      sends.add(send);

      const parent = element.parentElement;
      const unsubscribeUp = parent
        ? subscribe<DocHandleDescriptor>(parent, selector, (d) => {
            upstream = d;
            send();
          })
        : ((upstream = { url }), () => {});
      const load = () => {
        loaded = true;
        send();
      };
      ready.then(load, load);

      return () => {
        unsubscribeUp();
        sends.delete(send);
        if (sends.size === 0) live.delete(documentId);
      };
    });
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    folderHandle?.off("change", reindex);
    for (const handle of patchHandles.values()) handle.off("change", rebuild);
    patchHandles.clear();
    live.clear();
  };
}

function sameList(
  a: AutomergeUrl[] | undefined,
  b: AutomergeUrl[] | undefined
) {
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
