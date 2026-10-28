import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { isKeyhiveDocumentId } from "@inkandswitch/patchwork-filesystem";

export function isKeyhiveDoc(url: AutomergeUrl): boolean {
  try {
    return isKeyhiveDocumentId(parseAutomergeUrl(url).documentId);
  } catch {
    return false;
  }
}
