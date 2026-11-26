import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

export function isKeyhiveDoc(url: AutomergeUrl): boolean {
  try {
    const { binaryDocumentId } = parseAutomergeUrl(url);
    return (
      binaryDocumentId.length >= 32 &&
      binaryDocumentId.subarray(16, 32).some((byte) => byte !== 0)
    );
  } catch {
    return false;
  }
}
