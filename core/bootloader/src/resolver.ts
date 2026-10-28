// Turning a handoff request into a reply, given a Repo: walk a `/@/` path, or
// find a legacy automerge URL's document and resolve the path in it, and hand
// the response back inline. What to keep is the service worker's call, never a
// resolver's. A tab answers the service worker with its own Repo this way (see
// tab-resolver.ts), and the automerge worker answers the broadcasts nobody else
// could (automerge-protocol-handler).
import { hasHeads } from "@automerge/automerge/slim";
import {
  decodeHeads,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type StorageId,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import {
  getDefaultBranch,
  parsePath,
  readNode,
  resolvePath,
  walkPath,
  type WalkOptions,
} from "@inkandswitch/patchwork-filesystem";
import { toBytes } from "./content-hash.js";

import type {
  HandoffReplyMessage,
  HandoffRequestMessage,
} from "./types.js";

const RESOLVE_TIMEOUT_MS = 30_000;

const CATCH_UP_MS = 3_000;

function waitForHeads(
  handle: DocHandle<unknown>,
  hexHeads: string[],
  signal: AbortSignal
): Promise<boolean> {
  if (hasHeads(handle.doc(), hexHeads)) return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = () => {
      handle.off("heads-changed", check);
      signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (!hasHeads(handle.doc(), hexHeads)) return;
      cleanup();
      resolve(true);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    handle.on("heads-changed", check);
    signal.addEventListener("abort", onAbort);
    // The heads may have landed between the check above and subscribing.
    check();
  });
}

async function caughtUpWithPeers(
  repo: Repo,
  handle: DocHandle<unknown>,
  signal: AbortSignal
): Promise<void> {
  if (!repo.isSubductionConnected()) return;
  const peers = (await repo.connectedSubductionPeerIds()) as StorageId[];
  const caughtUp = () => {
    const states = peers.map((peer) => handle.isCaughtUpWith(peer));
    return (
      states.some((state) => state !== undefined) && !states.includes(false)
    );
  };
  if (caughtUp() || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      handle.off("remote-heads", check);
      handle.off("heads-changed", check);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (caughtUp()) done();
    };
    const timer = setTimeout(done, CATCH_UP_MS);
    handle.on("remote-heads", check);
    handle.on("heads-changed", check);
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
    else check();
  });
}

/**
 * Thrown instead of returning a Response when the request should fail as a
 * network error rather than resolve to something the caller can memoize.
 * See {@link HandoffAbortMessage}.
 */
class AbortHandoff extends Error {}

async function resolveAutomergeUrl(
  repo: Repo,
  automergeURL: URL,
  signal: AbortSignal
): Promise<Response> {
  const find = <T>(id: Parameters<Repo["find"]>[0]) =>
    repo.find<T>(id, { signal });
  const [maybeAutomergeUrl, ...path] = automergeURL.href.split("/");

  if (!isValidAutomergeUrl(maybeAutomergeUrl)) {
    return new Response("invalid automerge url", { status: 400 });
  }

  if (path.length && !path[path.length - 1]) path.pop();

  const { heads, hexHeads, documentId } = parseAutomergeUrl(maybeAutomergeUrl);

  // todo, maybe a bad idea? maybe we should throw instead of es-module-caching
  // the headless req
  if (!heads) {
    let folder = await find(maybeAutomergeUrl);
    await caughtUpWithPeers(repo, folder, signal);
    // Packages used to be published as a branches doc, which stands for its
    // default branch. The tab's ModuleWatcher looks packages up through here,
    // so this is where that's followed.
    const branch = getDefaultBranch(folder.doc());
    if (branch) {
      folder = await find(branch);
      await caughtUpWithPeers(repo, folder, signal);
    }
    const url = stringifyAutomergeUrl({
      documentId: folder.documentId,
      heads: folder.heads(),
    });
    const location = `/${encodeURIComponent(url)}${path.length ? `/${path.join("/")}` : ""}`;
    return Response.redirect(location, 307);
  }

  const baseHandle = await find(stringifyAutomergeUrl({ documentId }));
  if (!(await waitForHeads(baseHandle, hexHeads ?? [], signal))) {
    throw new AbortHandoff(
      `heads not found for ${maybeAutomergeUrl} within ${RESOLVE_TIMEOUT_MS}ms`
    );
  }

  const resolved = await resolvePath(
    repo,
    baseHandle.view(heads),
    path.map(decodeURIComponent)
  );
  if (!resolved) {
    throw new Error(
      `couldn't resolve ${path.join("/")} in folder at ${maybeAutomergeUrl}`
    );
  }

  const body: BodyInit =
    resolved.content instanceof Uint8Array
      ? (new Uint8Array(resolved.content) as BlobPart)
      : resolved.content;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": resolved.type,
      "cache-control": resolved.pinned
        ? "public, max-age=31536000, immutable"
        : "no-store",
    },
  });
}

function impatience(limit: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`resolve timeout after ${limit}ms`)),
      limit
    )
  );
}

/**
 * The walk's `find`: wait for pinned heads to arrive, or for a live document to catch up with
 * the sync server, within `signal`. Heads that never arrive are remembered in `missing`, so a
 * walk that fails because of them answers with a network error rather than a 404.
 */
function waitingFind(
  repo: Repo,
  signal: AbortSignal,
  missing: Set<string>
): NonNullable<WalkOptions["find"]> {
  return async (url: AutomergeUrl, heads?: UrlHeads) => {
    const handle = await repo.find(url, { signal });
    if (heads) {
      if (!(await waitForHeads(handle, decodeHeads(heads), signal))) {
        missing.add(url);
        throw new AbortHandoff(`heads ${heads.join(",")} of ${url} not found`);
      }
    } else {
      await caughtUpWithPeers(repo, handle, signal);
    }
    return handle;
  };
}

/**
 * A `/@/` path, answered inline: a 307 to the pinned form for a live path (or a pinned-looking
 * one that isn't canonical), the bytes for a canonical pinned one, 404 for one that doesn't
 * resolve. Pinned heads that never arrive throw {@link AbortHandoff}.
 */
async function resolveWalkPath(
  repo: Repo,
  path: string,
  accounts: ReadonlyMap<string, AutomergeUrl>,
  signal: AbortSignal
): Promise<Response> {
  try {
    parsePath(path);
  } catch (error) {
    return new Response(String(error), { status: 400 });
  }
  const missing = new Set<string>();
  const end = await walkPath(repo, path, {
    accounts,
    find: waitingFind(repo, signal, missing),
  });
  if (!end) {
    if (missing.size) {
      throw new AbortHandoff(`heads not found for ${[...missing].join(", ")}`);
    }
    return new Response(`nothing at ${path}`, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!end.canonical) {
    return new Response(null, {
      status: 307,
      headers: { location: `/@/${end.pinned}`, "cache-control": "no-store" },
    });
  }
  const read = await readNode(repo, end.node);
  if (!read) return new Response(`can't read ${path}`, { status: 404 });
  return new Response(toBytes(read.content) as BlobPart, {
    status: 200,
    headers: { "content-type": read.type },
  });
}

export type Resolver = {
  /**
   * Resolve `message`'s request and hand the response back inline, for the
   * service worker to serve and, if it chooses, keep. Undefined if it's neither
   * a `/@/` path nor an `automerge:` URL. `signal` cuts the 30s allowance short.
   */
  answer(
    message: HandoffRequestMessage,
    signal?: AbortSignal
  ): Promise<HandoffReplyMessage | undefined>;
};

export function createResolver(
  getRepo: () => Promise<Repo>,
  log: (...args: unknown[]) => void = () => {},
  accounts: () => ReadonlyMap<string, AutomergeUrl> = () => new Map()
): Resolver {
  const within = (signal?: AbortSignal) =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)])
      : AbortSignal.timeout(RESOLVE_TIMEOUT_MS);

  const resolveWithin = async (handoff: URL): Promise<Response> => {
    const repo = await getRepo();
    const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    return Promise.race([
      resolveAutomergeUrl(repo, handoff, signal),
      impatience(RESOLVE_TIMEOUT_MS),
    ]);
  };

  /** Lookups of a url without heads in flight, by that url. */
  const latestLookups = new Map<string, Promise<Response>>();

  /**
   * Resolve `handoff`, sharing the lookup with any already in flight for the
   * same url without heads. Every tab's ModuleWatcher asks for each package's
   * latest heads, again each time it changes, and none of it is cached, since
   * the answer moves; on a busy resolver those pile up into one full resolve
   * each. One that joins late gets the shared lookup's answer, or its timeout,
   * a little sooner than it would have its own.
   */
  const resolveHandoff = (handoff: URL): Promise<Response> => {
    const [maybeAutomergeUrl] = handoff.href.split("/");
    if (
      !isValidAutomergeUrl(maybeAutomergeUrl) ||
      parseAutomergeUrl(maybeAutomergeUrl).heads
    ) {
      return resolveWithin(handoff);
    }
    let lookup = latestLookups.get(handoff.href);
    if (!lookup) {
      lookup = resolveWithin(handoff).finally(() => {
        latestLookups.delete(handoff.href);
      });
      latestLookups.set(handoff.href, lookup);
    }
    // A redirect, so there's no body to share; each reply gets its own anyway.
    return lookup.then((response) => response.clone());
  };

  const inline = (id: string, status: number, body: string) =>
    ({
      id,
      type: "response",
      response: { status, body, headers: { "content-type": "text/plain" } },
    }) satisfies HandoffReplyMessage;

  const reply = async (id: string, response: Response): Promise<HandoffReplyMessage> => ({
    id,
    type: "response",
    response: {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body ? new Uint8Array(await response.arrayBuffer()) : undefined,
    },
  });

  return {
    async answer({ id, request }, signal) {
      let response: Response;
      try {
        if (request.path !== undefined) {
          const repo = await getRepo();
          const limit = within(signal);
          log(`resolving handoff ${id} for /@/${request.path}`);
          response = await Promise.race([
            resolveWalkPath(repo, request.path, accounts(), limit),
            new Promise<never>((_, reject) =>
              limit.addEventListener("abort", () =>
                reject(new AbortHandoff(`resolving /@/${request.path} timed out`))
              )
            ),
          ]);
        } else {
          let handoff: URL;
          try {
            handoff = new URL(request.handoffURL);
          } catch {
            console.error("couldn't parse handoff url", request);
            return inline(id, 400, `couldn't parse a special url out of ${request.url}`);
          }
          if (handoff.protocol !== "automerge:") return undefined;
          log(`resolving handoff ${id} for ${handoff}`);
          response = await resolveHandoff(handoff);
        }
      } catch (error) {
        if (error instanceof AbortHandoff) {
          return { id, type: "abort", reason: error.message };
        }
        console.error(`error resolving ${request.url}`, error);
        return inline(
          id,
          557,
          error instanceof Error
            ? `${error.message}\n\n${error.stack}`
            : String(error)
        );
      }

      try {
        // Everything goes back inline. The service worker keeps what's
        // immutable (see its serveHandoff), or checks it against the index.
        log(`responding inline to ${request.url} with ${response.status}`);
        return await reply(id, response);
      } catch (error) {
        console.error(`failed to reply for ${request.url}`, error);
        return inline(id, 558, String(error));
      }
    },
  };
}
