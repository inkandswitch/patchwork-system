import type { DocHandle, Repo, AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { FolderDoc, DocLink } from "@inkandswitch/patchwork-filesystem";
import { deleteAt } from "@automerge/automerge-repo/slim";
import { log } from "./debug.ts";
import { docLinkFromUrl } from "../lib/doc-link.ts";
import type { DropSpot } from "./dnd.ts";

// Track loaded folders to prevent memory leaks
const folderCache = new Map<AutomergeUrl, DocHandle<FolderDoc>>();

// Maximum folder nesting depth to prevent stack overflow
const MAX_FOLDER_DEPTH = 20;

// Helper to extract plain data from Automerge proxy objects
// structuredClone doesn't work with Automerge proxies - they contain
// internal symbols and proxies that cannot be cloned
function extractPlainDocLink(docLink: DocLink): DocLink {
  // Explicitly copy only the serializable properties
  const plain: DocLink = {
    url: docLink.url,
    name: docLink.name,
    type: docLink.type,
  };
  return plain;
}

export interface DropOperation {
  draggedIds: string[];
  draggedUrls: AutomergeUrl[];
  // Full payload items, used to add links when the dragged docs
  // aren't part of this sideboard's folder tree
  draggedItems?: Array<{ url: AutomergeUrl; name?: string; type?: string }>;
  sourceToolId: string;
  copyMode: boolean;
}

/** A docref that a drop put somewhere: its folder, its index there, its url. */
export type Landed = {
  folderUrl: AutomergeUrl;
  index: number;
  url: AutomergeUrl;
};

/** A drop that can't happen. The message is said to the person, as is. */
export class DropError extends Error {}

interface ItemLocation {
  url: AutomergeUrl;
  folderUrl: AutomergeUrl;
  index: number;
  item: DocLink;
}

/**
 * Put the dragged docs at `spot`. Returns the docrefs where they landed, or
 * null when the drop was a no-op (a row dropped back onto itself). Throws a
 * DropError when the drop isn't allowed.
 */
export async function executeDrop(
  operation: DropOperation,
  spot: DropSpot,
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  // True when the drop lands in the same <patchwork-view> the drag started in.
  // Only then can items be moved; see below.
  sameOriginView: boolean
): Promise<Landed[] | null> {
  log("executeDrop called with:", {
    draggedIds: operation.draggedIds,
    spot,
    copyMode: operation.copyMode,
    sourceToolId: operation.sourceToolId,
  });

  if (operation.draggedUrls.length === 0) {
    throw new DropError("There was nothing in that drag to drop.");
  }

  const sources = await findSources(
    rootFolderHandle,
    operation.draggedUrls,
    repo
  );
  const target = await folderHandle(repo, rootFolderHandle, spot.folderUrl);

  // Move only when the drag started inside *this same* <patchwork-view> and
  // the dragged docs are actually in this tree. A drag from another view, or an
  // external / bare-url drop (neither sets the origin view), is added to the
  // target folder as a link instead. Identity is the view element itself, not
  // the tool id, which is null for the fallback-mounted sideboard.
  if (!sameOriginView || sources.length === 0) {
    log("Cross-view/external drop, adding links. sameOriginView:", sameOriginView);
    return performAdd(repo, target, spot, operation);
  }

  if (sources.some((source) => isOntoItself(source, spot))) return null;
  const invalid = getDropValidationError(sources, spot, operation);
  if (invalid) throw new DropError(invalid);

  return operation.copyMode
    ? performCopy(target, spot, sources, repo, rootFolderHandle)
    : performMove(target, spot, sources, repo, rootFolderHandle);
}

// Remove every doc-link matching one of `urls` from the sideboard's folder
// tree, wherever it lives. Used by the context menu to remove a multi-selection
// in one shot. Deletes are batched per folder and applied high-index-first so
// earlier removals don't shift the indices of later ones.
export async function removeItemsByUrl(
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  urls: AutomergeUrl[]
): Promise<void> {
  const targets = new Set(urls);
  if (targets.size === 0) return;

  const removalsByFolder = new Map<DocHandle<FolderDoc>, number[]>();
  const visited = new Set<AutomergeUrl>();

  async function traverse(
    handle: DocHandle<FolderDoc>,
    depth: number
  ): Promise<void> {
    if (depth >= MAX_FOLDER_DEPTH) return;
    const doc = handle.doc();
    if (!doc?.docs) return;
    visited.add(handle.url);

    for (let i = 0; i < doc.docs.length; i++) {
      const child = doc.docs[i];

      if (targets.has(child.url)) {
        const indices = removalsByFolder.get(handle) ?? [];
        indices.push(i);
        removalsByFolder.set(handle, indices);
      }

      if (
        child.type === "folder" &&
        child.url &&
        child.url !== handle.url &&
        !visited.has(child.url)
      ) {
        let nested = folderCache.get(child.url);
        if (!nested) {
          try {
            nested = await repo.find<FolderDoc>(child.url);
            folderCache.set(child.url, nested);
          } catch (error) {
            log("Failed to load folder while removing:", child.url, error);
            continue;
          }
        }
        await traverse(nested, depth + 1);
      }
    }
  }

  await traverse(rootFolderHandle, 0);

  for (const [handle, indices] of removalsByFolder) {
    const sorted = [...indices].sort((a, b) => b - a);
    handle.change((doc) => {
      for (const index of sorted) deleteAt(doc.docs, index);
    });
  }
}

// Every folder the walk loads is cached here, so folderHandle() and
// isDescendantFolder() can read it without loading again.
async function findSources(
  rootFolderHandle: DocHandle<FolderDoc>,
  draggedUrls: AutomergeUrl[],
  repo: Repo
): Promise<ItemLocation[]> {
  const sources: ItemLocation[] = [];
  const visitedFolders = new Set<AutomergeUrl>();

  async function traverse(
    folderUrl: AutomergeUrl,
    docs: DocLink[] | undefined,
    depth: number
  ): Promise<void> {
    if (!docs) return;
    if (depth >= MAX_FOLDER_DEPTH) {
      log(`Max folder depth (${MAX_FOLDER_DEPTH}) reached, stopping traversal`);
      return;
    }
    visitedFolders.add(folderUrl);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (draggedUrls.includes(doc.url)) {
        sources.push({ url: doc.url, folderUrl, index: i, item: doc });
      }
      if (doc.type !== "folder" || !doc.url) continue;
      if (doc.url === folderUrl || visitedFolders.has(doc.url)) continue;

      let nested = folderCache.get(doc.url);
      if (!nested) {
        try {
          nested = await repo.find<FolderDoc>(doc.url);
          folderCache.set(doc.url, nested);
        } catch (error) {
          log("Failed to load folder:", doc.url, error);
          continue;
        }
      }
      await traverse(doc.url, nested.doc()?.docs, depth + 1);
    }
  }

  await traverse(rootFolderHandle.url, rootFolderHandle.doc()?.docs, 0);
  return sources;
}

async function folderHandle(
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  url: AutomergeUrl
): Promise<DocHandle<FolderDoc>> {
  if (url === rootFolderHandle.url) return rootFolderHandle;
  let handle = folderCache.get(url);
  if (!handle) {
    try {
      handle = await repo.find<FolderDoc>(url);
    } catch {
      throw new DropError("Couldn't open the folder to drop into.");
    }
    folderCache.set(url, handle);
  }
  return handle;
}

function isOntoItself(source: ItemLocation, spot: DropSpot) {
  return (
    source.folderUrl + "/" + source.index === spot.id ||
    (source.url === spot.id && spot.position !== "inside")
  );
}

function getDropValidationError(
  sources: ItemLocation[],
  spot: DropSpot,
  operation: DropOperation
): string | null {
  for (const source of sources) {
    const name = source.item.name || "That";
    if (
      source.folderUrl === spot.folderUrl &&
      spot.position === "inside" &&
      !operation.copyMode
    ) {
      return `“${name}” is already in this folder.`;
    }
    if (source.item.type === "folder" && source.url === spot.folderUrl) {
      return `Can't put “${name}” inside itself.`;
    }
    if (
      source.item.type === "folder" &&
      isDescendantFolder(source.url, spot.folderUrl)
    ) {
      return `Can't put “${name}” inside one of its own folders.`;
    }
  }
  return null;
}

// Helper to check if targetFolder is a descendant of potentialAncestor
function isDescendantFolder(
  potentialAncestor: AutomergeUrl,
  targetFolder: AutomergeUrl
): boolean {
  if (potentialAncestor === targetFolder) {
    return true;
  }

  // Check cached folder for descendants
  const ancestorHandle = folderCache.get(potentialAncestor);
  if (!ancestorHandle) return false;

  const ancestorDoc = ancestorHandle.doc();
  if (!ancestorDoc?.docs) return false;

  // Recursively check all subfolders
  for (const doc of ancestorDoc.docs) {
    if (doc.type === "folder" && doc.url) {
      if (doc.url === targetFolder) {
        return true;
      }
      if (isDescendantFolder(doc.url, targetFolder)) {
        return true;
      }
    }
  }

  return false;
}

function landedAt(
  folderUrl: AutomergeUrl,
  index: number,
  links: DocLink[]
): Landed[] {
  return links.map((link, i) => ({ folderUrl, index: index + i, url: link.url }));
}

async function performMove(
  target: DocHandle<FolderDoc>,
  spot: DropSpot,
  sources: ItemLocation[],
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>
): Promise<Landed[]> {
  log(`Moving ${sources.length} item(s) to`, spot);

  // Group sources by folder so each folder is changed once
  const sourcesByFolder = new Map<AutomergeUrl, ItemLocation[]>();
  for (const source of sources) {
    const list = sourcesByFolder.get(source.folderUrl) || [];
    list.push(source);
    sourcesByFolder.set(source.folderUrl, list);
  }

  const removedItems: DocLink[] = [];
  for (const [folderUrl, list] of sourcesByFolder) {
    const handle = await folderHandle(repo, rootFolderHandle, folderUrl);
    // Remove from the end first so earlier indices stay put
    const sorted = [...list].sort((a, b) => b.index - a.index);
    handle.change((doc) => {
      for (const source of sorted) {
        removedItems.unshift(extractPlainDocLink(doc.docs[source.index]));
        deleteAt(doc.docs, source.index);
      }
    });
  }

  // Rows taken out above the spot in its own folder shift it up
  const removedBefore = (sourcesByFolder.get(spot.folderUrl) ?? []).filter(
    (source) => source.index < spot.index
  ).length;
  const index = spot.index - removedBefore;

  target.change((doc) => {
    doc.docs.splice(index, 0, ...removedItems);
  });
  return landedAt(spot.folderUrl, index, removedItems);
}

// Add links for docs dragged in from outside this sideboard's folder tree
async function performAdd(
  repo: Repo,
  target: DocHandle<FolderDoc>,
  spot: DropSpot,
  operation: DropOperation
): Promise<Landed[]> {
  const candidates = (operation.draggedItems ?? []).filter(
    (item) => item.url && item.url !== spot.folderUrl
  );

  // Don't add items that are already present in the target folder -
  // dropping a doc into a folder it's already in shouldn't duplicate it.
  const existingUrls = new Set(target.doc()?.docs?.map((doc) => doc.url) ?? []);
  const fresh = candidates.filter((item) => !existingUrls.has(item.url));
  if (candidates.length > 0 && fresh.length === 0) {
    const name = candidates[0].name;
    throw new DropError(
      candidates.length === 1 && name
        ? `“${name}” is already in this folder.`
        : "Those are already in this folder."
    );
  }

  const links = (
    await Promise.all(
      fresh.map(async (item): Promise<DocLink | null> => {
        if (item.name && item.type) {
          return { url: item.url, name: item.name, type: item.type };
        }
        // Bare url (e.g. dragged link text) - resolve name/type from the doc
        try {
          return await docLinkFromUrl(repo, item.url);
        } catch (error) {
          log("Failed to resolve dropped doc:", item.url, error);
          return null;
        }
      })
    )
  ).filter((link): link is DocLink => link !== null);

  if (links.length === 0) {
    throw new DropError("Couldn't open the dropped document.");
  }

  log(`Adding ${links.length} link(s) at index:`, spot.index);
  target.change((doc) => {
    doc.docs.splice(spot.index, 0, ...links);
  });
  return landedAt(spot.folderUrl, spot.index, links);
}

async function performCopy(
  target: DocHandle<FolderDoc>,
  spot: DropSpot,
  sources: ItemLocation[],
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>
): Promise<Landed[]> {
  log(`Copying ${sources.length} item(s) to`, spot);

  const itemsToCopy: DocLink[] = [];
  for (const source of sources) {
    const handle = await folderHandle(repo, rootFolderHandle, source.folderUrl);
    const item = handle.doc()?.docs?.[source.index];
    if (item) itemsToCopy.push(extractPlainDocLink(item));
  }

  target.change((doc) => {
    doc.docs.splice(spot.index, 0, ...itemsToCopy);
  });
  return landedAt(spot.folderUrl, spot.index, itemsToCopy);
}
