import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

/**
 * What a tab could ask of keyhive.
 *
 * @deprecated Patchwork no longer uses keyhive, and nothing provides one.
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
 * Whether `url` names a document keyhive minted.
 *
 * @deprecated Patchwork no longer uses keyhive, so no document is one: this
 * always returns false.
 */
export function isKeyhiveDoc(_url: AutomergeUrl): boolean {
  return false;
}
