import {
  type DocHandle,
  type Repo,
  isImmutableString,
} from "@automerge/automerge-repo/slim";
import { type PathProvider, asLink, providerFor, valueAt } from "./providers.js";

export type Resolved = {
  content: string | Uint8Array;
  type: string;
  /**
   * True when every document on the path — the root and each link followed — was addressed with
   * heads, so this URL names these exact bytes and always will.
   *
   * Heads on a URL pin the document they name and nothing further. Links inside a folder or a
   * directory are ordinarily bare, so `/{root#heads}/a/b` reads a pinned root and then follows
   * whatever those links point at *now*: the content can move while the URL does not. A caller
   * that treats such a URL as content-addressed — an HTTP cache, say — will serve what it stored
   * the first time, forever.
   */
  pinned: boolean;
};

/**
 * State carried down a single resolution: the documents already seen, for cycle detection, and
 * whether every step so far was pinned.
 */
type Walk = {
  visited: Set<string>;
  pinned: boolean;
};

/** A URL carries heads when it has a fragment: `automerge:abc#heads`. */
const hasHeads = (url: unknown): boolean => String(url).includes("#");

/** @deprecated Use {@link PathProvider}, which replaces it. */
export type FolderStrategy = PathProvider;

/**
 * Resolve `parts` against `node`, a document or a value inside one, using the provider of the
 * document it belongs to. Following a link hands the rest to that document's own provider.
 */
async function resolveIn(
  repo: Repo,
  provider: PathProvider,
  node: unknown,
  parts: string[],
  walk: Walk
): Promise<Resolved | undefined> {
  if (parts.length === 0) return materialize(repo, node, undefined, walk);

  const found = provider.lookup(node, parts);
  if (!found) return undefined;
  const { child, consumed } = found;
  const rest = parts.slice(consumed);
  if ("value" in child) return resolveIn(repo, provider, child.value, rest, walk);
  if ("sub" in child) {
    const value = valueAt(node, child.sub);
    return value === undefined ? undefined : resolveIn(repo, provider, value, rest, walk);
  }

  // A union (an account's mount) is read through its first binding.
  const link = "link" in child ? child.link : child.union[0];
  if (!link) return undefined;
  // A step that consumes no parts can revisit the same url with the same remaining parts: a
  // cycle.
  const key = `${link}|${rest.join("/")}`;
  if (walk.visited.has(key)) return undefined;
  walk.visited.add(key);
  // Following a bare link means everything below this point is current, not fixed.
  walk.pinned &&= hasHeads(link);
  const next = await repo.find(link);
  return resolvePathInternal(repo, next, rest, walk);
}

// rule of thumb: bytes pass through, anything else gets JSON.stringify'd unless
// a .mimeType hint is in scope (FileDoc-shape provides one). default mime is
// application/json so strings without a hint become valid JSON.

async function materialize(
  repo: Repo,
  node: unknown,
  typeHint?: string,
  walk: Walk = { visited: new Set(), pinned: false }
): Promise<Resolved | undefined> {
  const link = asLink(node);
  if (link) {
    if (walk.visited.has(link)) return undefined;
    walk.visited.add(link);
    walk.pinned &&= hasHeads(link);
    const next = await repo.find(link);
    return materialize(repo, next.doc(), typeHint, walk);
  }

  if (
    node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    !(node instanceof Uint8Array) &&
    !isImmutableString(node) &&
    "content" in node
  ) {
    const obj = node as { content?: unknown; mimeType?: string };
    return materialize(repo, obj.content, obj.mimeType ?? typeHint, walk);
  }

  if (node instanceof Uint8Array) {
    return {
      content: node,
      type: typeHint ?? "application/octet-stream",
      pinned: walk.pinned,
    };
  }

  // String with a mime hint: pass through. Without: JSON-encode so the response
  // body matches the declared application/json type.
  if (typeof node === "string") {
    if (typeHint) return { content: node, type: typeHint, pinned: walk.pinned };
    return {
      content: JSON.stringify(node),
      type: "application/json",
      pinned: walk.pinned,
    };
  }

  if (isImmutableString(node)) {
    const s = String(node);
    if (typeHint) return { content: s, type: typeHint, pinned: walk.pinned };
    return {
      content: JSON.stringify(s),
      type: "application/json",
      pinned: walk.pinned,
    };
  }

  if (
    typeof node === "number" ||
    typeof node === "boolean" ||
    (node && typeof node === "object")
  ) {
    try {
      return {
        content: JSON.stringify(node),
        type: typeHint ?? "application/json",
        pinned: walk.pinned,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function resolvePathInternal(
  repo: Repo,
  handle: DocHandle<unknown>,
  parts: string[],
  walk: Walk
): Promise<Resolved | undefined> {
  if (parts.length === 0) {
    return materialize(repo, handle.doc(), undefined, walk);
  }

  const doc = handle.doc();
  const provider = providerFor(doc);
  return provider ? resolveIn(repo, provider, doc, parts, walk) : undefined;
}

export async function resolvePath(
  repo: Repo,
  rootHandle: DocHandle<unknown>,
  parts: string[]
): Promise<Resolved | undefined> {
  // A view handle's url carries the heads it was taken at; a live handle's does not. So the root
  // announces whether it is pinned, and every link followed can only take that away.
  return resolvePathInternal(repo, rootHandle, parts, {
    visited: new Set(),
    pinned: hasHeads(rootHandle.url),
  });
}

/**
 * What `node` serves as, the way {@link resolvePath} serves the end of a path: a file doc's
 * content with its mime type, bytes as they are, anything else as JSON.
 */
export async function readNode(
  repo: Repo,
  node: unknown
): Promise<{ content: string | Uint8Array; type: string } | undefined> {
  const read = await materialize(repo, node);
  return read && { content: read.content, type: read.type };
}
