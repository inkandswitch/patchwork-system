import {
  documentIdToBinary,
  type DocumentId,
} from "@automerge/automerge-repo/slim";

/**
 * Whether a document is keyhive-protected: its binary id carries a non-zero
 * second half, where a pre-keyhive document's is empty.
 */
export function isKeyhiveDocumentId(documentId: DocumentId): boolean {
  const bytes = documentIdToBinary(documentId);
  return (
    !!bytes && bytes.length >= 32 && bytes.subarray(16, 32).some((byte) => byte !== 0)
  );
}
