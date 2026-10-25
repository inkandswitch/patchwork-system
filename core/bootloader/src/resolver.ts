// Turning a handoff request into a reply, given a Repo: find the automerge
// URL's document, resolve the path in it, and either write the response into
// the service worker's cache or hand it back inline. A tab answers the service
// worker with its own Repo this way (see tab-resolver.ts), and the automerge
// worker answers the broadcasts nobody else could (automerge-protocol-handler).
import { hasHeads } from "@automerge/automerge/slim";
import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocHandle,
  type Repo,
  type StorageId,
} from "@automerge/automerge-repo/slim";
import {
  getDefaultBranch,
  resolvePath,
} from "@inkandswitch/patchwork-filesystem";

import type {
  HandoffReplyMessage,
  HandoffRequestMessage,
} from "./types.js";

const RESOLVE_TIMEOUT_MS = 30_000;

const CACHEABLE_STATUSES = [200, 203, 204];

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

export type Resolver = {
  /**
   * Resolve `message`'s request and say how the service worker should answer
   * it, having written the response into its cache if it's one to keep.
   * Undefined if the special URL isn't an `automerge:` one.
   */
  answer(message: HandoffRequestMessage): Promise<HandoffReplyMessage | undefined>;
};

export function createResolver(
  getRepo: () => Promise<Repo>,
  log: (...args: unknown[]) => void = () => {}
): Resolver {
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

  return {
    async answer({ id, cachename, request }) {
      let handoff: URL;
      try {
        handoff = new URL(request.handoffURL);
      } catch {
        console.error("couldn't parse handoff url", request);
        return inline(id, 400, `couldn't parse a special url out of ${request.url}`);
      }
      if (handoff.protocol !== "automerge:") return undefined;

      let response: Response;
      try {
        log(`resolving handoff ${id} for ${handoff}`);
        response = await resolveHandoff(handoff);
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
        const immutable =
          CACHEABLE_STATUSES.includes(response.status) &&
          !/(^|,)\s*no-store(\s*,|$)/.test(
            response.headers.get("cache-control") ?? ""
          );
        if (!immutable) {
          // Errors, redirects and the like go back inline for the service
          // worker to serve directly. Mutable responses aren't cached because
          // the same URL can resolve to different content later.
          log(`responding inline to ${request.url} with ${response.status}`);
          return {
            id,
            type: "response",
            response: {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: response.body
                ? new Uint8Array(await response.arrayBuffer())
                : undefined,
            },
          };
        }

        // Reconstruct the request the service worker is holding so the entry
        // matches its cache.match. `destination` isn't constructible but
        // doesn't participate in cache matching.
        const cacheKey = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          referrer: request.referrer,
        });
        const cache = await caches.open(cachename);
        await cache.put(cacheKey, response);
        log(`cached ${cacheKey.url} in ${cachename}`);
        return { id, type: "cached" };
      } catch (error) {
        console.error(`failed to reply for ${request.url}`, error);
        return inline(id, 558, String(error));
      }
    },
  };
}
