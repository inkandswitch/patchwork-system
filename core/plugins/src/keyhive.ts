import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

/**
 * What a tab can ask of keyhive. Keyhive itself lives in the automerge worker,
 * which holds the only copy of its state; a tab reaches it through this.
 */
export interface PatchworkHive {
  /** This device's keyhive identity (its verifying key, base64). */
  readonly id: string;
  /** Whether this device may read the document at `url`. */
  canRead(url: AutomergeUrl): Promise<boolean>;
  /** Whether this device may change the document at `url`. */
  canWrite(url: AutomergeUrl): Promise<boolean>;
  /** Calls `listener` whenever keyhive learns something that may change access. */
  onChange(listener: () => void): () => void;
}

/**
 * Whether `url` names a document keyhive minted. Automerge-repo 3 ids are 32
 * bytes; an id carried over from repo 2 is 16 bytes, zero-padded to 32 by
 * `normalizeDocumentId`, so it is the zero tail that says it predates keyhive.
 */
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
