// A container's file list: what each file under it is, at the moment it was pinned. A pinned
// path names one by its hash (`<idhash>@<heads>~<listHash>`), so the service worker checks the
// list against the URL and each file's bytes against the list, and trusts nothing in between.
// No document ids: a resolver finds a file by walking to it by name from the container at its
// pinned heads, and reads it at the heads the list recorded.
import type { DocumentId, Repo } from "@automerge/automerge-repo/slim";
import { contentHash, toBytes } from "./content-hash.js";
import { isKeyhiveDocumentId } from "./keyhive.js";
import { formatHeads, parsePath } from "./paths.js";
import { listFiles, type WalkOptions } from "./walk.js";

export type FileEntry = {
  /** SHA-256 of the bytes the file serves as. */
  sha256: string;
  type: string;
  /** The heads the file's document was read at; absent for a value inside the container. */
  heads?: string;
  /** Whether the bytes may be kept in the content store. */
  store: boolean;
};

export type FileList = { v: 1; files: Record<string, FileEntry> };

/** JSON with every object's keys sorted and no whitespace, so equal values are equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const isEntry = (value: unknown): value is FileEntry => {
  const entry = value as FileEntry;
  return (
    !!entry &&
    typeof entry.sha256 === "string" &&
    typeof entry.type === "string" &&
    typeof entry.store === "boolean" &&
    (entry.heads === undefined || typeof entry.heads === "string")
  );
};

/** A list from its bytes, or undefined if they aren't one. Check the hash before trusting it. */
export function parseFileList(bytes: Uint8Array): FileList | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value?.v !== 1 || !value.files || typeof value.files !== "object") return undefined;
    if (!Object.values(value.files).every(isEntry)) return undefined;
    return value as FileList;
  } catch {
    return undefined;
  }
}

/**
 * The file list of the container `path` is in: every file under it, or only the tails in
 * `only`. Returns its bytes and hash, and the container's pinned path without `~listHash`.
 * Undefined unless `path` is canonical. `missing` names files that couldn't be read, which a
 * whole list then leaves out.
 *
 * What may be stored: content from unprotected documents, and keyhive-protected content only
 * when it's reached through `/packages`, since package code needs to load fast at boot and user
 * documents don't. Nothing under a share link.
 */
export async function buildFileList(
  repo: Repo,
  path: string,
  options: WalkOptions & {
    findFile?: WalkOptions["find"];
    only?: string[];
    isProtected?: (documentId: DocumentId) => boolean;
  }
): Promise<
  | { prefix: string; list: FileList; bytes: Uint8Array; listHash: string; missing: string[] }
  | undefined
> {
  const listed = await listFiles(repo, path, options);
  if (!listed) return undefined;
  const { root, segments } = parsePath(listed.prefix);
  const first = segments[0];
  const throughPackages = first?.kind === "name" && first.name === "packages";
  const isProtected = options.isProtected ?? isKeyhiveDocumentId;

  const files: Record<string, FileEntry> = {};
  for (const file of listed.files) {
    files[file.tail] = {
      sha256: await contentHash(toBytes(file.content)),
      type: file.type,
      ...(file.heads ? { heads: formatHeads(file.heads) } : {}),
      store: root.kind === "account" && (throughPackages || !isProtected(file.documentId)),
    };
  }
  const list: FileList = { v: 1, files };
  const bytes = new TextEncoder().encode(canonicalJson(list));
  return {
    prefix: listed.prefix,
    list,
    bytes,
    listHash: await contentHash(bytes),
    missing: listed.missing,
  };
}
