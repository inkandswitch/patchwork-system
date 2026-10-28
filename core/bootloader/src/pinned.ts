// Serving a pinned `/@/` URL: find what its bytes must hash to, read them from the content
// store or a resolver, check them, and decide whether to keep them. Only the automerge worker's
// manifests say what a URL's bytes must hash to (see index-channel.ts); a store entry or a
// resolver's answer that doesn't match is never served.
import type { ContentStore } from "./content-store.js";
import type {
  HandoffRequestMessage,
  IndexEntry,
  Manifest,
} from "./types.js";

const BASE58 = "[1-9A-HJ-NP-Za-km-z]+";
const DOC_STEP = new RegExp(`^${BASE58}@${BASE58}(\\.${BASE58})*$`);
const ACCOUNT_ROOT = new RegExp(`^(${BASE58})(@${BASE58}(\\.${BASE58})*)?$`);
const SHARE_PREFIX = "automerge:";

const reencode = (segment: string) => encodeURIComponent(decodeURIComponent(segment));

export type NormalizedPath = {
  /**
   * The keys this path may be indexed under, most likely first. A segment shaped like a doc step
   * (`react@18.3.1`) may be a name, and only the worker's manifest can say, so there's a key for
   * each place the doc steps could end; every name after that point is re-encoded.
   */
  keys: string[];
  /** The first key up to and including its last doc step: the document its manifest covers. */
  prefix: string;
  acctHash?: string;
  /** False for a live path, whose names resolve at current heads. */
  pinned: boolean;
  /** A share link, `automerge:<documentId>@<heads>`: nothing under it is stored. */
  share: boolean;
};

/**
 * The path after `/@/`, normalized so every spelling of one file has one key among its
 * candidates: segments are percent-decoded and re-encoded, and empty ones dropped. Undefined for
 * a malformed escape or a root that isn't an account hash or a share link.
 */
export function normalizePinned(path: string): NormalizedPath | undefined {
  const [root, ...rest] = path.split("/").filter(Boolean);
  if (!root) return undefined;
  try {
    const decodedRoot = decodeURIComponent(root);
    let head: string;
    let acctHash: string | undefined;
    let pinned: boolean;
    const share = decodedRoot.startsWith(SHARE_PREFIX);
    if (share) {
      head = decodedRoot;
      pinned = true;
    } else {
      const match = ACCOUNT_ROOT.exec(root);
      if (!match) return undefined;
      head = root;
      acctHash = match[1];
      pinned = !!match[2];
    }

    // Doc-step-shaped segments after the root, latest first.
    const splits = rest
      .map((segment, i) => (DOC_STEP.test(segment) ? i : -1))
      .filter((i) => i >= 0)
      .reverse();
    const keyAt = (split: number) =>
      [
        head,
        ...rest.map((segment, i) =>
          i <= split && DOC_STEP.test(segment) ? segment : reencode(segment)
        ),
      ].join("/");
    const keys = splits.length ? splits.map(keyAt) : [keyAt(-1)];
    // Encoded segments hold no "/", so the first key splits back into its segments.
    const prefix = keys[0]
      .split("/")
      .slice(0, (splits[0] ?? -1) + 2)
      .join("/");
    return { keys, prefix, acctHash, pinned, share };
  } catch {
    return undefined;
  }
}

/** Add a manifest's entries to the index, under `prefix/tail`. */
export function indexManifest(
  index: Map<string, IndexEntry>,
  manifest: Manifest
): void {
  for (const [tail, entry] of Object.entries(manifest.entries)) {
    index.set(tail ? `${manifest.prefix}/${tail}` : manifest.prefix, entry);
  }
}

/** Thrown to fail the request as a network error: nothing that can be memoized. */
export class PinnedAbort extends Error {}

export type PinnedDeps = {
  index: Map<string, IndexEntry>;
  /** Undefined: nothing is read or written (a share link). */
  store: ContentStore | undefined;
  hash(bytes: Uint8Array): Promise<string>;
  /** Ask the automerge worker for the manifest covering `key`; undefined if it can't answer. */
  manifest(key: string): Promise<Manifest | undefined>;
  /**
   * Ask a tab or the automerge worker for `key`'s bytes: undefined if it doesn't resolve, a
   * Response for any answer that isn't bytes (a redirect for a path that isn't canonical).
   */
  resolve(
    key: string
  ): Promise<{ body: Uint8Array; contentType: string } | Response | undefined>;
  warn(message: string): void;
  /** Keep the service worker alive for work that outlives the response. */
  keep(work: Promise<unknown>): void;
};

const lookup = (index: Map<string, IndexEntry>, keys: string[]) => {
  for (const key of keys) {
    const entry = index.get(key);
    if (entry) return entry;
  }
  return undefined;
};

const respond = (bytes: Uint8Array, contentType: string, immutable: boolean) =>
  new Response(bytes as BlobPart, {
    headers: {
      "content-type": contentType,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    },
  });

/**
 * Serve a pinned URL, given its candidate keys (see {@link normalizePinned}):
 *
 * 1. Find its index entry, asking for a manifest on a miss.
 * 2. With an entry, read the store and hash what's there: a match is served; a mismatch is
 *    deleted, warned about, and treated as a miss.
 * 3. Ask a resolver and hash its bytes. With an entry, a match is served (and stored, if the
 *    entry allows) and a mismatch fails as a network error. Without one, because no worker
 *    answered, the bytes are served as they are and kept nowhere.
 */
export async function servePinned(
  keys: string[],
  deps: PinnedDeps
): Promise<Response> {
  let entry = lookup(deps.index, keys);
  if (!entry) {
    const manifest = await deps.manifest(keys[0]);
    if (manifest) indexManifest(deps.index, manifest);
    entry = lookup(deps.index, keys);
  }

  if (entry && deps.store) {
    const stored = await deps.store.get(entry.sha256);
    if (stored) {
      if ((await deps.hash(stored)) === entry.sha256) {
        return respond(stored, entry.contentType, true);
      }
      deps.warn(
        `content store entry ${entry.sha256} for ${keys[0]} doesn't hash to its key; deleting it`
      );
      await deps.store.delete(entry.sha256);
    }
  }

  const answer = await deps.resolve(keys[0]);
  if (!answer) {
    return new Response(`nothing at ${keys[0]}`, {
      status: 404,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  if (answer instanceof Response) {
    if (entry) {
      throw new PinnedAbort(
        `${keys[0]} is in the automerge worker's manifest, but a resolver answered ${answer.status}`
      );
    }
    return answer;
  }
  if (!entry) return respond(answer.body, answer.contentType, false);

  if ((await deps.hash(answer.body)) !== entry.sha256) {
    throw new PinnedAbort(
      `${keys[0]} resolved to bytes that don't match the automerge worker's manifest`
    );
  }
  if (entry.store && deps.store) {
    deps.keep(deps.store.put(entry.sha256, answer.body));
  }
  return respond(answer.body, entry.contentType, true);
}

/**
 * Wrap a manifest fetcher so concurrent calls for one prefix share a request. A settled request
 * is forgotten: its entries are in the index by then.
 */
export function sharedManifests(
  fetch: (key: string) => Promise<Manifest | undefined>,
  prefixOf: (key: string) => string
): (key: string) => Promise<Manifest | undefined> {
  const inFlight = new Map<string, Promise<Manifest | undefined>>();
  return (key) => {
    const prefix = prefixOf(key);
    let request = inFlight.get(prefix);
    if (!request) {
      request = fetch(key).finally(() => inFlight.delete(prefix));
      inFlight.set(prefix, request);
    }
    return request;
  };
}

/**
 * The handoff the service worker sends tabs and the automerge worker: `to` is a legacy special
 * URL (`automerge:…`), or a `/@/` path. A path's `handoffURL` is `patchwork-path:` and the path,
 * which resolvers from before paths parse and then decline.
 */
export function handoffRequest(
  request: Request,
  cachename: string,
  to: URL | string
): HandoffRequestMessage {
  return {
    id: crypto.randomUUID(),
    type: "request",
    cachename,
    request: {
      url: request.url,
      handoffURL: typeof to === "string" ? `patchwork-path:${to}` : to.href,
      ...(typeof to === "string" ? { path: to } : {}),
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
      destination: request.destination,
      referrer: request.referrer,
    },
  };
}
