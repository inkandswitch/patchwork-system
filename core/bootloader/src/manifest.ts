// The automerge worker's side of the index: what every file under a pinned document hashes to,
// and whether the service worker may keep it.
import {
  stringifyAutomergeUrl,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  listFiles,
  parsePath,
  type WalkOptions,
} from "@inkandswitch/patchwork-filesystem";
import { isKeyhiveDoc } from "@inkandswitch/patchwork-plugins";
import { contentHash, toBytes } from "./content-hash.js";
import type { IndexEntry, Manifest } from "./types.js";

const isProtectedDoc = (documentId: DocumentId) =>
  isKeyhiveDoc(stringifyAutomergeUrl({ documentId }));

/**
 * The manifest covering canonical pinned `path`, or undefined if it isn't one.
 *
 * What may be stored: content from unprotected documents, and keyhive-protected content only
 * when it's reached through `/packages`, since package code needs to load fast at boot and user
 * documents don't. Nothing under a share link.
 */
export async function buildManifest(
  repo: Repo,
  path: string,
  options: WalkOptions & { isProtected?: (documentId: DocumentId) => boolean }
): Promise<Manifest | undefined> {
  const listed = await listFiles(repo, path, options);
  if (!listed) return undefined;
  const { root, segments } = parsePath(listed.prefix);
  const first = segments[0];
  const throughPackages = first?.kind === "name" && first.name === "packages";
  const isProtected = options.isProtected ?? isProtectedDoc;

  const entries: Record<string, IndexEntry> = {};
  for await (const file of listed.files) {
    entries[file.tail] = {
      sha256: await contentHash(toBytes(file.content)),
      contentType: file.type,
      store:
        root.kind === "account" &&
        (throughPackages || !isProtected(file.documentId)),
    };
  }
  return { prefix: listed.prefix, entries };
}
