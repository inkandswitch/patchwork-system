import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

export type HasPatchworkMetadata<Type extends string = string> = {
  "@patchwork": {
    type: Type;
    suggestedImportUrl?: string;
    frozenImportUrl?: string;
    copies?: AutomergeUrl[];
    copyOf?: AutomergeUrl;
    history?: AutomergeUrl;
  };
};

export function getType(doc: Partial<HasPatchworkMetadata>) {
  return doc["@patchwork"]?.type;
}

export function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A `suggestedImportUrl` is only honored when it names a directly-importable
 * module: either an `http:`/`https:` URL (a module bundle served over the
 * network) or an `automerge:` URL (a folder doc imported via the service
 * worker, like {@link importPackageFromFolderDocUrl}). Anything else is ignored
 * so a stray value is never treated as a module.
 */
export function isImportableSuggestedUrl(
  url: string | undefined
): url is string {
  return isHttpUrl(url) || isValidAutomergeUrl(url);
}

export function getSuggestedImportUrl(doc: Partial<HasPatchworkMetadata>) {
  const url = doc["@patchwork"]?.suggestedImportUrl;
  return isImportableSuggestedUrl(url) ? url : undefined;
}

export function getFrozenImportUrl(doc: Partial<HasPatchworkMetadata>) {
  const url = doc["@patchwork"]?.frozenImportUrl;
  return isImportableSuggestedUrl(url) ? url : undefined;
}

export function getCopies(doc: Partial<HasPatchworkMetadata>) {
  return doc["@patchwork"]?.copies || [];
}

export function getCopyOf(doc: Partial<HasPatchworkMetadata>) {
  return doc["@patchwork"]?.copyOf;
}
