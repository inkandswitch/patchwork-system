import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { PatchworkHive } from "@inkandswitch/patchwork-plugins";

/**
 * Whether `hive` says this device may open `docUrl`.
 *
 * @deprecated Patchwork no longer uses keyhive, and views no longer check
 * access before mounting.
 */
export function hasActiveAccess(
  hive: PatchworkHive,
  docUrl: AutomergeUrl
): Promise<boolean> {
  return hive.canRead(docUrl);
}
