// Serving a pinned `/@/` URL. Its last container step names a file list by hash
// (`<idhash>@<heads>~<listHash>`), so the URL vouches for the list and the list for each file's
// bytes. Lists, store entries and resolvers' answers are all checked against those hashes; none
// is trusted for who made it (spec, section 5).
import {
  parseFileList,
  type FileList,
} from "@inkandswitch/patchwork-filesystem";
import type { ContentStore } from "./content-store.js";
import type { HandoffRequestMessage } from "./types.js";

const BASE58 = "[1-9A-HJ-NP-Za-km-z]+";
const LIST = "~[A-Za-z0-9_-]+";
const DOC_STEP = new RegExp(`^${BASE58}@${BASE58}(?:\\.${BASE58})*(?:${LIST})?$`);
const ACCOUNT_ROOT = new RegExp(`^(${BASE58})(@${BASE58}(?:\\.${BASE58})*(?:${LIST})?)?$`);
const SHARE_PREFIX = "automerge:";

const reencode = (segment: string) => encodeURIComponent(decodeURIComponent(segment));
const listHashOf = (step: string) => /~([A-Za-z0-9_-]+)$/.exec(step)?.[1];
const withoutList = (step: string) => step.replace(/~[A-Za-z0-9_-]+$/, "");

/**
 * One reading of a pinned path: the container's pinned path (without its own `~listHash`), the
 * names after it, and the list hash its step carries, if any.
 */
export type Candidate = { prefix: string; tail: string; listHash?: string };

export type NormalizedPath = {
  /**
   * The readings of this path, most likely first. A segment shaped like a doc step
   * (`react@18.3.1`) may be a name, so there's a reading for each place the container could be;
   * every segment after it is a name, re-encoded.
   */
  candidates: Candidate[];
  acctHash?: string;
  /** False for a live path, whose names resolve at current heads. */
  pinned: boolean;
  /** A share link, `automerge:<documentId>@<heads>`: nothing under it is stored. */
  share: boolean;
};

/**
 * The path after `/@/`, normalized so every spelling of one file has the same candidates:
 * segments are percent-decoded and re-encoded, and empty ones dropped. Undefined for a malformed
 * escape or a root that isn't an account hash or a share link.
 */
export function normalizePinned(path: string): NormalizedPath | undefined {
  const [root, ...rest] = path.split("/").filter(Boolean);
  if (!root) return undefined;
  try {
    const decodedRoot = decodeURIComponent(root);
    const share = decodedRoot.startsWith(SHARE_PREFIX);
    let acctHash: string | undefined;
    let pinned = true;
    if (!share) {
      const match = ACCOUNT_ROOT.exec(root);
      if (!match) return undefined;
      acctHash = match[1];
      pinned = !!match[2];
    }
    const head = share ? decodedRoot : root;

    // The container is the segment at `split`, or the root at -1.
    const reading = (split: number): Candidate => {
      const container = split < 0 ? head : rest[split];
      const before =
        split < 0
          ? []
          : [head, ...rest.slice(0, split).map((s) => (DOC_STEP.test(s) ? s : reencode(s)))];
      const listHash = listHashOf(container);
      return {
        prefix: [...before, withoutList(container)].join("/"),
        tail: rest.slice(split + 1).map(reencode).join("/"),
        ...(listHash ? { listHash } : {}),
      };
    };

    // Doc-step-shaped segments after the root, latest first; then the root, when it's a
    // container step itself (a share link, or a root that names a list), or when nothing else is.
    const splits = rest
      .map((segment, i) => (DOC_STEP.test(segment) ? i : -1))
      .filter((i) => i >= 0)
      .reverse();
    if (share || listHashOf(head) || !splits.length) splits.push(-1);
    return { candidates: splits.map(reading), acctHash, pinned, share };
  } catch {
    return undefined;
  }
}

/** Thrown to fail the request as a network error: nothing that can be memoized. */
export class PinnedAbort extends Error {}

export type PinnedDeps = {
  /** File lists held in memory, by list hash: ones that may not be stored, and a cache. */
  lists: Map<string, FileList>;
  /** Undefined: nothing is read or written (a share link). */
  store: ContentStore | undefined;
  hash(bytes: Uint8Array): Promise<string>;
  /**
   * Ask a resolver for the list of the container at `prefix`, covering only the tail `only` if
   * given, else every file: its bytes, or undefined.
   */
  buildList(prefix: string, only?: string): Promise<Uint8Array | undefined>;
  /**
   * Ask a tab or the automerge worker for the file at `path`, read at `heads` if given: its
   * bytes, a Response for any other answer (a redirect, a 404), or undefined.
   */
  resolve(
    path: string,
    heads?: string
  ): Promise<{ body: Uint8Array; contentType: string } | Response | undefined>;
  warn(message: string): void;
  /** Keep the service worker alive for work that outlives the response. */
  keep(work: Promise<unknown>): void;
};

/**
 * Keep a list if `bytes` hash to `listHash`: in memory always, and in the store too when every
 * file in it may be stored. False if they don't match, or aren't a list.
 */
export async function keepFileList(
  bytes: Uint8Array,
  listHash: string,
  deps: Pick<PinnedDeps, "lists" | "store" | "hash" | "keep">
): Promise<boolean> {
  if ((await deps.hash(bytes)) !== listHash) return false;
  const list = parseFileList(bytes);
  if (!list) return false;
  deps.lists.set(listHash, list);
  if (deps.store && Object.values(list.files).every((entry) => entry.store)) {
    deps.keep(deps.store.put(listHash, bytes));
  }
  return true;
}

/**
 * The list a URL names: from memory, from the store (checked), or rebuilt (checked). A rebuild
 * tries the one-file list a redirect hands out first, which costs one file read, then the whole
 * container's.
 */
async function loadList(
  { prefix, tail, listHash }: { prefix: string; tail: string; listHash: string },
  deps: PinnedDeps
): Promise<FileList | undefined> {
  const known = deps.lists.get(listHash);
  if (known) return known;
  const stored = await deps.store?.get(listHash);
  if (stored) {
    // Already in the store: kept in memory only.
    if (await keepFileList(stored, listHash, { ...deps, store: undefined })) {
      return deps.lists.get(listHash);
    }
    deps.warn(`content store entry ${listHash} isn't the file list it's named for; deleting it`);
    await deps.store!.delete(listHash);
  }
  for (const only of [tail, undefined]) {
    const built = await deps.buildList(prefix, only);
    if (built && (await keepFileList(built, listHash, deps))) return deps.lists.get(listHash);
  }
  return undefined;
}

const respond = (bytes: Uint8Array, contentType: string, immutable: boolean) =>
  new Response(bytes as BlobPart, {
    headers: {
      "content-type": contentType,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    },
  });

const join = (prefix: string, tail: string) => (tail ? `${prefix}/${tail}` : prefix);

/**
 * Serve a pinned URL (see the spec's *Request flow for a pinned URL*):
 *
 * 1. Load the list its container step names; none to be had fails as a network error.
 * 2. Look the file up in it; not there, 404.
 * 3. Read the store by the file's hash and check it; a mismatch is deleted.
 * 4. Ask a resolver for the file at the heads the list recorded and check that; a match is served
 *    (and stored, if the list allows), anything else fails as a network error.
 *
 * A path with no list anywhere is served live from a resolver: `no-store`, unchecked.
 */
export async function servePinned(
  normalized: Pick<NormalizedPath, "candidates">,
  deps: PinnedDeps
): Promise<Response> {
  const listed = normalized.candidates.find(
    (candidate): candidate is Candidate & { listHash: string } => !!candidate.listHash
  );
  if (!listed) {
    const [first] = normalized.candidates;
    const path = join(first.prefix, first.tail);
    const answer = await deps.resolve(path, undefined);
    if (answer instanceof Response) return answer;
    if (!answer) return new Response(`nothing at /@/${path}`, { status: 404 });
    return respond(answer.body, answer.contentType, false);
  }

  const path = join(listed.prefix, listed.tail);
  const list = await loadList(listed, deps);
  if (!list) {
    throw new PinnedAbort(`no file list ${listed.listHash} to check /@/${path} against`);
  }
  const entry = list.files[listed.tail];
  if (!entry) {
    return new Response(`/@/${path} isn't in its file list`, {
      status: 404,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }

  if (deps.store) {
    const stored = await deps.store.get(entry.sha256);
    if (stored) {
      if ((await deps.hash(stored)) === entry.sha256) {
        return respond(stored, entry.type, true);
      }
      deps.warn(
        `content store entry ${entry.sha256} for /@/${path} doesn't hash to its key; deleting it`
      );
      await deps.store.delete(entry.sha256);
    }
  }

  const answer = await deps.resolve(path, entry.heads);
  if (!answer || answer instanceof Response) {
    throw new PinnedAbort(
      `/@/${path} is in its file list, but a resolver answered ${answer?.status ?? "nothing"}`
    );
  }
  if ((await deps.hash(answer.body)) !== entry.sha256) {
    throw new PinnedAbort(`/@/${path} resolved to bytes that don't match its file list`);
  }
  if (entry.store && deps.store) deps.keep(deps.store.put(entry.sha256, answer.body));
  return respond(answer.body, entry.type, true);
}

/**
 * Wrap `fn` so concurrent calls with one key share a request, made with the first call's other
 * arguments. A settled request is forgotten.
 */
export function sharedRequests<A extends unknown[], T>(
  fn: (key: string, ...args: A) => Promise<T>
): (key: string, ...args: A) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key, ...args) => {
    let request = inFlight.get(key);
    if (!request) {
      request = fn(key, ...args).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
    }
    return request;
  };
}

/**
 * The handoff the service worker sends tabs and the automerge worker: `to` is a legacy special
 * URL (`automerge:…`), or a `/@/` path, with the heads to read its file at, or a request for
 * its container's file list. A path's `handoffURL` is `patchwork-path:` and the path, which
 * resolvers from before paths parse and then decline.
 */
export function handoffRequest(
  request: Request,
  cachename: string,
  to: URL | { path: string; heads?: string; list?: boolean; only?: string }
): HandoffRequestMessage {
  const target =
    to instanceof URL
      ? { handoffURL: to.href }
      : {
          handoffURL: `patchwork-path:${to.path}`,
          path: to.path,
          ...(to.heads ? { heads: to.heads } : {}),
          ...(to.list ? { list: true } : {}),
          ...(to.only !== undefined ? { only: to.only } : {}),
        };
  return {
    id: crypto.randomUUID(),
    type: "request",
    cachename,
    request: {
      url: request.url,
      ...target,
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
      destination: request.destination,
      referrer: request.referrer,
    },
  };
}
