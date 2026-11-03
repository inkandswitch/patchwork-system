import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

type Access = Awaited<ReturnType<AutomergeRepoKeyhive["accessForDoc"]>>;

/**
 * The active identity's access to `docUrl`, or undefined if it has none.
 *
 * A site built on ARK 0.6 (`keyhive.ark`) still has public access, and there
 * `accessForDoc` counts only what was granted to the identity directly. Its
 * `bestAccessForDoc` adds the public grant, so a public doc opens for
 * everyone. 0.8 has no public access and only `accessForDoc`.
 */
export function activeAccessForDoc(
  hive: AutomergeRepoKeyhive,
  docUrl: AutomergeUrl
): Promise<Access> {
  const id = hive.active.individual.id;
  const { bestAccessForDoc } = hive as {
    bestAccessForDoc?: (id: unknown, docUrl: AutomergeUrl) => Promise<Access>;
  };
  return bestAccessForDoc
    ? bestAccessForDoc.call(hive, id, docUrl)
    : hive.accessForDoc(id, docUrl);
}
