import {
  isImmutableString,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo/slim";

/**
 * A folder entry as the view sees it, whichever doc shape it came from.
 * `path` is set (and `url` isn't) for a subdirectory of a pushwork directory
 * doc, which has no doc of its own.
 * @typedef {{ name: string, type: string, url?: string, path?: string }} Link
 */

// Any string in a doc may be stored as a plain string or as an
// ImmutableString (pushwork writes links that way); read them the same.
export function asString(v) {
  if (typeof v === "string") return v;
  if (isImmutableString(v)) return String(v);
  return undefined;
}

export function asUrl(v) {
  const s = asString(v);
  return s !== undefined && isValidAutomergeUrl(s) ? s : undefined;
}

// A pushwork "vfs" directory doc:
//   { "@patchwork": { type: "directory", title? }, "a/b.txt": url, ... }
// Every other key is a slash-separated path to a leaf doc.
export function isDirectoryDoc(doc) {
  return asString(doc?.["@patchwork"]?.type) === "directory";
}

const DIRECTORY_RESERVED = new Set(["@patchwork", "lastSyncAt"]);

// Mirrors pushwork's folder shape, which types a file link by its extension.
function fileType(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "file";
}

/** @returns {Link[]} the links in a folder doc's `docs` list. */
export function folderLinks(doc) {
  const links = [];
  for (const link of Array.isArray(doc?.docs) ? doc.docs : []) {
    const url = asUrl(link?.url);
    if (!url) continue;
    links.push({
      url,
      name: asString(link.name) ?? "Untitled",
      type: asString(link.type) ?? "",
    });
  }
  return links;
}

/**
 * The immediate children of `path` ("" for the top) in a directory doc:
 * subdirectories first, then files, each by name.
 * @returns {Link[]}
 */
export function directoryLinks(doc, path = "") {
  const prefix = path ? `${path}/` : "";
  const dirs = new Set();
  const files = [];
  for (const [key, value] of Object.entries(doc ?? {})) {
    if (DIRECTORY_RESERVED.has(key) || !key.startsWith(prefix)) continue;
    const url = asUrl(value);
    if (!url) continue;
    const rest = key.slice(prefix.length).split("/").filter(Boolean);
    if (rest.length === 0) continue;
    if (rest.length > 1) dirs.add(rest[0]);
    else files.push({ url, name: rest[0], type: fileType(rest[0]) });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [
    ...[...dirs]
      .map((name) => ({ name, type: "folder", path: prefix + name }))
      .sort(byName),
    ...files.sort(byName),
  ];
}
