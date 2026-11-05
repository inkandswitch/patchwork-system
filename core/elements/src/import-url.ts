import { isHttpUrl } from "@inkandswitch/patchwork-filesystem";

// Characters that render as nothing or reorder the text around them, beyond
// what `\s` already covers: controls and format characters (zero-width
// spaces, bidi overrides, soft hyphens), the Hangul fillers and variation
// selectors. In a url shown in a trust prompt they let the doc make it read as
// something it isn't.
const INVISIBLE_OR_REORDERING =
  /[\p{Cc}\p{Cf}\u115f\u1160\u3164\uffa0\ufe00-\ufe0f]/u;

/**
 * The form of a document's `suggestedImportUrl` that is safe both to show in
 * the "run this package?" prompt and to import, or undefined when it can't be
 * shown faithfully.
 *
 * The url is written by whoever wrote the document. Shown raw, it can carry
 * line breaks and a paragraph of fake reassurance, and the URL parser drops
 * those line breaks before importing, so the module still loads. An http(s)
 * url is shown as its parsed `href`, which is plain ASCII (tabs and newlines
 * removed, everything else percent-encoded, an IDN host in punycode) and
 * imports the same module. Any other url (an `automerge:` package) has no
 * such canonical form, so one with whitespace or invisible characters in it
 * isn't offered at all.
 */
export function presentableImportUrl(
  url: string | undefined
): string | undefined {
  if (!url) return undefined;
  if (isHttpUrl(url)) return new URL(url).href;
  if (/\s/.test(url) || INVISIBLE_OR_REORDERING.test(url)) return undefined;
  return url;
}

/** Who the prompt says the code comes from: the host, for an http(s) url. */
export function importSource(url: string): string {
  return isHttpUrl(url) ? new URL(url).host : "an Automerge document";
}
