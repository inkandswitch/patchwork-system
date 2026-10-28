// The router's hash: `#doc=…&path=…&tool=…`, read and written the same way
// everywhere so re-serializing the same params is byte-identical.
import {
  isValidAutomergeUrl,
  isValidDocumentId,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
} from "@automerge/vanillajs/slim";

// `doc=` and `draft=` are automerge URLs, kept literal rather than
// percent-encoded so links stay readable. `path=` is a live path whose
// segments are already encoded, with literal slashes between them.
const RAW_HASH_KEYS = new Set(["doc", "path", "draft"]);
// A stable order means re-serializing the same logical params is
// byte-identical, avoiding spurious `hashchange` round-trips.
export const HASH_KEY_ORDER = ["doc", "path", "tool", "type", "title", "frame", "draft"];

/**
 * The hash's params. `URLSearchParams` decodes every value, which would turn
 * an encoded slash in a path segment (`a%2Fb`) into a real one, so `path` is
 * put back as its raw text.
 */
export function parseHashParams(hash: string): URLSearchParams {
  const params = new URLSearchParams(hash);
  const raw = /(?:^|&)path=([^&]*)/.exec(hash)?.[1];
  if (raw !== undefined) params.set("path", raw);
  return params;
}

export function serializeHashParams(params: URLSearchParams): string {
  const keys = [...HASH_KEY_ORDER, ...params.keys()];
  const parts: string[] = [];
  const emitted = new Set<string>();
  for (const key of keys) {
    if (emitted.has(key)) continue;
    const value = params.get(key);
    if (!value) continue;
    emitted.add(key);
    parts.push(
      `${key}=${RAW_HASH_KEYS.has(key) ? value : encodeURIComponent(value)}`
    );
  }
  return parts.join("&");
}

/**
 * Coerce a `doc=` hash param to a full automerge URL. Accepts a full URL
 * (`automerge:<id>[#heads]`) or a bare document id, for older links.
 */
export function docParamToUrl(docParam: string | null): AutomergeUrl | undefined {
  if (!docParam) return undefined;
  if (isValidAutomergeUrl(docParam as AutomergeUrl)) {
    return docParam as AutomergeUrl;
  }
  const documentId = docParam.replace(/^automerge:/, "");
  if (!isValidDocumentId(documentId)) return undefined;
  return stringifyAutomergeUrl({ documentId: documentId as DocumentId });
}
