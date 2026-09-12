import {
  type DocHandle,
  type Repo,
  isImmutableString,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "./types.js";
import { getType } from "./metadata.js";

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

export interface FolderStrategy {
  matches(doc: unknown): boolean;
  resolve(
    repo: Repo,
    handle: DocHandle<unknown>,
    parts: string[],
    walk: Walk
  ): Promise<Resolved | undefined>;
}

const folderStrategy: FolderStrategy = {
  matches(doc) {
    return (
      !!doc &&
      typeof doc === "object" &&
      "docs" in doc &&
      Array.isArray((doc as { docs: unknown }).docs)
    );
  },
  async resolve(repo, handle, parts, walk) {
    const folder = handle.doc() as FolderDoc | undefined;
    if (!folder?.docs) return undefined;

    const part = parts[0];
    const docLink = folder.docs.find((doc) => doc.name === part);
    if (!docLink) return undefined;

    // Following a bare link means everything below this point is current, not fixed.
    walk.pinned &&= hasHeads(docLink.url);
    const next = await repo.find(docLink.url);
    return resolvePathInternal(repo, next, parts.slice(1), walk);
  },
};

const directoryStrategy: FolderStrategy = {
  matches(doc) {
    return getType(doc as Parameters<typeof getType>[0]) === "directory";
  },
  async resolve(repo, handle, parts, walk) {
    return walkDirectoryDoc(repo, handle.doc(), parts, walk);
  },
};

async function walkDirectoryDoc(
  repo: Repo,
  node: unknown,
  parts: string[],
  walk: Walk
): Promise<Resolved | undefined> {
  if (typeof node === "string" && isValidAutomergeUrl(node)) {
    // Following a url consumes no parts, so revisiting the same url with the
    // same remaining parts is a cycle.
    const key = `${node}|${parts.join("/")}`;
    if (walk.visited.has(key)) return undefined;
    walk.visited.add(key);
    walk.pinned &&= hasHeads(node);
    const next = await repo.find(node);
    return resolvePathInternal(repo, next, parts, walk);
  }

  if (parts.length === 0) {
    return materialize(repo, node, undefined, walk);
  }

  if (!node || typeof node !== "object" || node instanceof Uint8Array) {
    return undefined;
  }

  // Longest-prefix match: try "main/dist/index.js", then "main/dist", then "main"
  const obj = node as Record<string, unknown>;
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join("/");
    if (key in obj) {
      return walkDirectoryDoc(repo, obj[key], parts.slice(i), walk);
    }
  }
  return undefined;
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
  if (typeof node === "string" && isValidAutomergeUrl(node)) {
    if (walk.visited.has(node)) return undefined;
    walk.visited.add(node);
    walk.pinned &&= hasHeads(node);
    const next = await repo.find(node);
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
    return { content: node, type: typeHint ?? "application/octet-stream", pinned: walk.pinned };
  }

  // String with a mime hint: pass through. Without: JSON-encode so the response
  // body matches the declared application/json type.
  if (typeof node === "string") {
    if (typeHint) return { content: node, type: typeHint, pinned: walk.pinned };
    return { content: JSON.stringify(node), type: "application/json", pinned: walk.pinned };
  }

  if (isImmutableString(node)) {
    const s = String(node);
    if (typeHint) return { content: s, type: typeHint, pinned: walk.pinned };
    return { content: JSON.stringify(s), type: "application/json", pinned: walk.pinned };
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

const STRATEGIES: FolderStrategy[] = [directoryStrategy, folderStrategy];

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
  for (const strategy of STRATEGIES) {
    if (strategy.matches(doc)) {
      return strategy.resolve(repo, handle, parts, walk);
    }
  }
  return undefined;
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
