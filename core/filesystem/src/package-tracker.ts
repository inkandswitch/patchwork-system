import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { getType } from "./metadata.js";
import type { BranchesDoc } from "./types.js";
import { getImportableUrlFromAutomergeUrl } from "./urls.js";

export const DEFAULT_BRANCH = "default";

/**
 * The doc a branches doc stands for, its `default` branch, or undefined if
 * `doc` isn't a branches doc. Throws for a branches doc without one.
 */
export function getDefaultBranch(doc: unknown): AutomergeUrl | undefined {
  const branches = doc as Partial<BranchesDoc> | undefined;
  if (!branches || getType(branches) !== "branches") return undefined;
  const branch = branches.branches?.[DEFAULT_BRANCH];
  if (!branch) {
    throw new Error(`branches doc has no "${DEFAULT_BRANCH}" branch`);
  }
  return branch;
}

/**
 * How a {@link ModuleWatcher} follows a package's doc (a folder or a
 * directory): what version of it to import, and when there may be a newer one.
 */
export type PackageTracker = {
  /**
   * `url` at its latest heads. A branches doc stands for its `default`
   * branch, so the url returned can be a different document's.
   */
  findLatest(url: AutomergeUrl): Promise<AutomergeUrl>;
  /**
   * Call `onChange` whenever the doc at `url` may have new heads, until the
   * returned function is called. A tracker that can tell passes `seen`, a
   * summary of what it holds of the doc: the same `seen` twice means nothing
   * arrived in between, so there's nothing to look up. It's not a version to
   * import, and it may come when nothing moved. Without it, every call costs
   * a `findLatest`.
   */
  watch(url: AutomergeUrl, onChange: (seen?: string) => void): () => void;
};

/**
 * Package docs held in `repo`, for as long as they're watched. Works
 * anywhere, but keeps every package's doc in memory.
 */
export function trackPackagesInRepo(repo: Repo): PackageTracker {
  return {
    async findLatest(url) {
      let handle = await repo.find<unknown>(url);
      const branch = getDefaultBranch(handle.doc());
      if (branch) handle = await repo.find(branch);
      return handle.view(handle.heads()).url;
    },
    watch(url, onChange) {
      let handle: DocHandle<unknown> | undefined;
      let stopped = false;
      // The change event's payload isn't what the tracker says.
      const changed = () => onChange();
      Promise.resolve()
        .then(() => repo.find(url))
        .then(
        (found) => {
          if (stopped) return;
          handle = found;
          handle.on("change", changed);
        },
        (error) => console.warn(`couldn't watch ${url}`, error)
      );
      return () => {
        stopped = true;
        handle?.off("change", changed);
      };
    },
  };
}

/**
 * Package docs looked up by the service worker: the automerge worker
 * redirects a package url without heads to the one at the doc's latest heads,
 * and lets go of the doc soon after. Whether they load on this thread is up
 * to `watch`.
 */
export function trackPackagesViaServiceWorker(
  watch: PackageTracker["watch"]
): PackageTracker {
  return { findLatest: fetchLatestViaServiceWorker, watch };
}

/**
 * Ask the service worker for `url` at its latest heads. The `package.json` it
 * lands on is what an import of the package fetches first, so following the
 * redirect isn't wasted.
 */
export async function fetchLatestViaServiceWorker(
  url: AutomergeUrl
): Promise<AutomergeUrl> {
  if (parseAutomergeUrl(url).heads) return url;
  const response = await fetch(
    new URL("package.json", getImportableUrlFromAutomergeUrl(url))
  );
  const latest = decodeURIComponent(
    new URL(response.url).pathname.split("/")[1] ?? ""
  );
  if (!isValidAutomergeUrl(latest) || !parseAutomergeUrl(latest).heads) {
    // The automerge worker's 557 carries why it couldn't resolve the doc.
    const reason = (await response.text?.().catch(() => ""))
      ?.split("\n")[0]
      ?.trim();
    throw new Error(
      `the service worker didn't redirect ${url} to its heads (HTTP ${response.status} from ${response.url})${reason ? `: ${reason}` : ""}`
    );
  }
  return latest;
}
