// The automerge worker's side of the index: what every file under a pinned document hashes to,
// and whether the service worker may keep it.
import {
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  listFiles,
  parsePath,
  walkPath,
  type WalkOptions,
} from "@inkandswitch/patchwork-filesystem";
import { isKeyhiveDoc } from "@inkandswitch/patchwork-plugins";
import { contentHash, toBytes } from "./content-hash.js";
import { postIndexAnswer } from "./index-channel.js";
import type {
  IndexAnswer,
  IndexEntry,
  Manifest,
  ManifestRequestMessage,
} from "./types.js";

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
  options: WalkOptions & {
    findFile?: WalkOptions["find"];
    isProtected?: (documentId: DocumentId) => boolean;
  }
): Promise<{ manifest: Manifest; missing: string[] } | undefined> {
  const listed = await listFiles(repo, path, options);
  if (!listed) return undefined;
  const { root, segments } = parsePath(listed.prefix);
  const first = segments[0];
  const throughPackages = first?.kind === "name" && first.name === "packages";
  const isProtected = options.isProtected ?? isProtectedDoc;

  const entries: Record<string, IndexEntry> = {};
  for (const file of listed.files) {
    entries[file.tail] = {
      sha256: await contentHash(toBytes(file.content)),
      contentType: file.type,
      store:
        root.kind === "account" &&
        (throughPackages || !isProtected(file.documentId)),
    };
  }
  return { manifest: { prefix: listed.prefix, entries }, missing: listed.missing };
}

const REMEMBERED_MANIFESTS = 64;

/**
 * The automerge worker's answer to the service worker's manifest requests. A request names a
 * file; its manifest covers the container the file is in, so every file of a package shares one.
 * Manifests are remembered by that container's pinned path, which never changes meaning, and
 * concurrent requests for one share a build.
 */
export function createManifestHandler(
  getRepo: () => Promise<Repo>,
  accounts: () => ReadonlyMap<string, AutomergeUrl>,
  options: {
    post?: (answer: IndexAnswer) => Promise<boolean>;
    /** The walk's find, per request: one that waits for heads, in the worker. */
    find?: (repo: Repo) => WalkOptions["find"];
    /** The listing's find for file docs, per build, with a budget of its own. */
    findFile?: (repo: Repo) => WalkOptions["find"];
    log?: (...args: unknown[]) => void;
  } = {}
): (message: ManifestRequestMessage) => Promise<void> {
  const post = options.post ?? ((answer) => postIndexAnswer(answer));
  const remembered = new Map<string, Manifest>();
  const building = new Map<
    string,
    Promise<{ manifest: Manifest; missing: string[] } | undefined>
  >();

  const manifestFor = async (path: string): Promise<Manifest> => {
    const repo = await getRepo();
    const walk: WalkOptions = { accounts: accounts(), find: options.find?.(repo) };
    const end = await walkPath(repo, path, walk);
    const prefix = end?.canonical ? end.container?.pinned : undefined;
    if (!prefix) throw new Error(`${path} isn't a pinned path this worker can walk`);

    const known = remembered.get(prefix);
    if (known) {
      remembered.delete(prefix);
      remembered.set(prefix, known);
      return known;
    }
    let build = building.get(prefix);
    if (!build) {
      build = buildManifest(repo, prefix, {
        ...walk,
        findFile: options.findFile?.(repo),
      }).finally(() => building.delete(prefix));
      building.set(prefix, build);
    }
    const built = await build;
    if (!built) throw new Error(`couldn't list the files under ${prefix}`);
    // A partial manifest still checks what it lists, but isn't kept: the next
    // request tries the missing files again.
    if (built.missing.length) {
      options.log?.(
        `manifest for ${prefix} is missing ${built.missing.length} file(s); not keeping it`
      );
      return built.manifest;
    }
    remembered.set(prefix, built.manifest);
    if (remembered.size > REMEMBERED_MANIFESTS) {
      remembered.delete(remembered.keys().next().value!);
    }
    return built.manifest;
  };

  return async ({ id, path }) => {
    let answer: IndexAnswer;
    try {
      answer = { id, path, manifest: await manifestFor(path) };
    } catch (error) {
      answer = {
        id,
        path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    options.log?.(`manifest ${id} for ${path}: ${answer.error ?? "built"}`);
    if (!(await post(answer))) {
      console.warn(`couldn't get manifest ${id} to the service worker`);
    }
  };
}
