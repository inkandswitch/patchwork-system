import {
  AutomergeUrl,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim";

/**
 * Convert an automerge URL to an Account Token that the user can
 * paste in to login on another device.
 * The doc ID is the only part of the URL actually used by the system,
 * the rest is just for humans to understand what this string is for.
 */
export function automergeUrlToAccountToken(
  url: AutomergeUrl,
  name: string
): string {
  const { documentId } = parseAutomergeUrl(url);
  return `account:${encodeURIComponent(name)}/${documentId}`;
}

/**
 * Parse an account token back to an automerge URL.
 * Returns undefined if the token can't be parsed as an automerge URL.
 */
export function accountTokenToAutomergeUrl(
  token: string
): AutomergeUrl | undefined {
  const match = token.match(/^account:([^/]+)\/(.+)$/);
  if (!match || !match[2]) {
    return undefined;
  }
  const documentId = match[2];
  const url = `automerge:${documentId}`;
  if (!isValidAutomergeUrl(url)) {
    return undefined;
  }
  return url as AutomergeUrl;
}
