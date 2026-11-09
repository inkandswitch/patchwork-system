import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import debug from "debug";

const log = debug("patchwork:folder-tree");

/**
 * Finds `root` and every folder under it, a level at a time, and none of the
 * files: a link is followed only when it says it's a folder. A folder that
 * can't be found is skipped, along with what's under it. Resolves with how many
 * were found, or after `timeoutMs` with the folders still loading left to carry
 * on in the background. `onProgress` hears the count as each one is found, and
 * once more when the walk is over, timeout or not.
 */
export async function loadFolderTree(
  repo: Repo,
  root: AutomergeUrl,
  {
    timeoutMs,
    onProgress,
  }: {
    timeoutMs?: number;
    onProgress?: (progress: { found: number; done: boolean }) => void;
  } = {}
): Promise<number> {
  const seen = new Set<string>();
  let found = 0;

  const load = async (url: AutomergeUrl): Promise<void> => {
    const key = String(url);
    if (seen.has(key)) return;
    seen.add(key);
    let folder: FolderDoc | undefined;
    try {
      folder = (await repo.find<FolderDoc>(url)).doc();
    } catch (error) {
      log("couldn't find folder", url, error);
      return;
    }
    found++;
    onProgress?.({ found, done: false });
    const links = Array.isArray(folder?.docs) ? folder.docs : [];
    await Promise.all(
      links
        .filter((link) => String(link?.type) === "folder")
        .map((link) => String(link.url))
        .filter(isValidAutomergeUrl)
        .map(load)
    );
  };

  const walked = load(root).then(() => {
    log(`found ${found} folders`);
    onProgress?.({ found, done: true });
  });
  if (timeoutMs === undefined) {
    await walked;
    return found;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `patchwork: still loading folders after ${timeoutMs}ms (${found} so far); going on without them`
      );
      resolve();
    }, timeoutMs);
  });
  await Promise.race([walked, timedOut]);
  clearTimeout(timer);
  return found;
}
