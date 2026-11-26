import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

/**
 * The package a plugin came from, whatever version of it: an Automerge url's
 * document, or the document in a service-worker url that carries one
 * (`…/automerge%3A<id>%23<heads>/path/entry.js`) and the rest of that url,
 * which says which file. Any other url is its own source.
 */
export function sourceOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (isValidAutomergeUrl(url)) return documentOf(url);
  const segments = url.split("/");
  for (const [i, segment] of segments.entries()) {
    const decoded = decode(segment);
    if (!isValidAutomergeUrl(decoded)) continue;
    segments[i] = encodeURIComponent(documentOf(decoded));
    return segments.join("/");
  }
  return url;
}

// The url of the document `url` names, without heads or a path.
function documentOf(url: AutomergeUrl): AutomergeUrl {
  return stringifyAutomergeUrl({
    documentId: parseAutomergeUrl(url).documentId,
  });
}

// A path segment decoded, or "" if it isn't validly encoded.
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
