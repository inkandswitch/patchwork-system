import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";
import type { DocLink, FolderDoc } from "@inkandswitch/patchwork-filesystem";

// Rows currently mounted in each panel, refcounted (a doc can appear in more
// than one folder). Children only mount when their folder is expanded, so a
// mounted row means every folder above it is already open — a selection made
// by clicking a row needs no walk at all.
const mountedRows = new WeakMap<object, Map<AutomergeUrl, number>>();

/** Record that `panel` is rendering a row for `url`. Returns the unmount. */
export function markMounted(panel: object, url: AutomergeUrl): () => void {
  let rows = mountedRows.get(panel);
  if (!rows) mountedRows.set(panel, (rows = new Map()));
  rows.set(url, (rows.get(url) ?? 0) + 1);
  return () => {
    const n = rows.get(url)! - 1;
    if (n) rows.set(url, n);
    else rows.delete(url);
  };
}

export function isMounted(panel: object, url: AutomergeUrl): boolean {
  return !!mountedRows.get(panel)?.has(url);
}

// Reverse index of every folder we've loaded: child url → the folders that
// link to it. Kept current by listening to each folder handle's changes, so it
// can answer "which folders lead to this doc?" by walking up, without any finds.
const parents = new Map<AutomergeUrl, Set<AutomergeUrl>>();
const children = new Map<AutomergeUrl, Set<AutomergeUrl>>();
const watched = new WeakSet<DocHandle<FolderDoc>>();

function indexFolder(folderUrl: AutomergeUrl, docs: DocLink[] | undefined) {
  const next = new Set(docs?.map((link) => link.url));
  const prev = children.get(folderUrl);
  if (prev) {
    for (const child of prev) {
      if (next.has(child)) continue;
      const set = parents.get(child);
      set?.delete(folderUrl);
      if (!set?.size) parents.delete(child);
    }
  }
  for (const child of next) {
    let set = parents.get(child);
    if (!set) parents.set(child, (set = new Set()));
    set.add(folderUrl);
  }
  children.set(folderUrl, next);
}

// Selected urls that a complete walk from a root didn't find, keyed by root.
// Every folder that walk saw is now watched, so this stays true until one of
// them changes — then it's dropped wholesale and the next reveal looks again.
const missing = new Map<AutomergeUrl, Set<AutomergeUrl>>();

/** Add a folder to the parent index and keep it current. Idempotent. */
export function watchFolder(handle: DocHandle<FolderDoc>) {
  if (watched.has(handle)) return;
  watched.add(handle);
  indexFolder(handle.url, handle.doc()?.docs);
  handle.on("change", () => {
    indexFolder(handle.url, handle.doc()?.docs);
    missing.clear();
  });
}

/**
 * Walk up the parent index from each selected doc and collect every folder on
 * a path that reaches `rootUrl` (including the root itself). `unreached` is the
 * selected docs that can't be traced to the root with what's indexed so far.
 */
export function expandedFoldersFromIndex(
  rootUrl: AutomergeUrl,
  selected: Iterable<AutomergeUrl>
): { folders: Set<AutomergeUrl>; unreached: AutomergeUrl[] } {
  const folders = new Set<AutomergeUrl>();
  const unreached: AutomergeUrl[] = [];
  // url → whether it reaches the root. Seeded false on entry so a cycle
  // terminates instead of recursing forever.
  const reaches = new Map<AutomergeUrl, boolean>([[rootUrl, true]]);

  function up(url: AutomergeUrl): boolean {
    const known = reaches.get(url);
    if (known !== undefined) return known;
    reaches.set(url, false);
    let found = false;
    for (const parent of parents.get(url) ?? []) {
      if (up(parent)) {
        folders.add(parent);
        found = true;
      }
    }
    reaches.set(url, found);
    return found;
  }

  for (const url of selected) {
    if (url !== rootUrl && !up(url)) unreached.push(url);
  }
  return { folders, unreached };
}

/**
 * Load folders down from `rootUrl` (one cached `repo.find` each), adding each
 * to the parent index, until every url in `wanted` has been seen in some
 * folder's docrefs. Leaf docs are never loaded. Each folder is visited once,
 * however many parents link to it, and a cycle just hits an already-seen
 * folder.
 *
 * Returns whether the answer is trustworthy: everything was found, or the
 * whole tree was walked without a folder failing to load.
 */
async function indexUntilFound(
  repo: Repo,
  rootUrl: AutomergeUrl,
  wanted: Set<AutomergeUrl>
): Promise<boolean> {
  const remaining = new Set(wanted);
  const seen = new Set<AutomergeUrl>();
  let failed = false;

  async function visit(url: AutomergeUrl): Promise<void> {
    if (!remaining.size || seen.has(url)) return;
    seen.add(url);
    let docs: DocLink[];
    try {
      const handle = await repo.find<FolderDoc>(url);
      watchFolder(handle);
      docs = handle.doc()?.docs ?? [];
    } catch {
      failed = true;
      return;
    }
    for (const link of docs) remaining.delete(link.url);
    await Promise.all(
      docs.filter((link) => link.type === "folder").map((link) => visit(link.url))
    );
  }

  await visit(rootUrl);
  return !remaining.size || !failed;
}

/**
 * The set of folders under `rootUrl` that must be expanded for the selected
 * docs to be visible.
 *
 * Answered from the parent index when it can be. Otherwise walks the tree just
 * far enough to find what's missing, indexing as it goes, so the next reveal
 * of anything it passed is free. A selection that isn't under the root at all
 * costs one full walk, then nothing until the tree changes.
 */
export async function foldersToReveal(
  repo: Repo,
  rootUrl: AutomergeUrl,
  selected: AutomergeUrl[]
): Promise<Set<AutomergeUrl>> {
  const indexed = expandedFoldersFromIndex(rootUrl, selected);
  const known = missing.get(rootUrl);
  const search = indexed.unreached.filter((url) => !known?.has(url));
  if (!search.length) return indexed.folders;

  const complete = await indexUntilFound(repo, rootUrl, new Set(search));
  const { folders, unreached } = expandedFoldersFromIndex(rootUrl, selected);
  if (complete && unreached.length) {
    const set = missing.get(rootUrl) ?? new Set();
    for (const url of unreached) set.add(url);
    missing.set(rootUrl, set);
  }
  return folders;
}
