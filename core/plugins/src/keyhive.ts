import { docIdFromAutomergeUrl } from "@automerge/automerge-repo-keyhive";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export function isKeyhiveDoc(url: AutomergeUrl): boolean {
  try {
    docIdFromAutomergeUrl(url);
    return true;
  } catch {
    return false;
  }
}
