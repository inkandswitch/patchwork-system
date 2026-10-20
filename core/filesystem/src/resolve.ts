import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  isImmutableString,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "./types.js";
import { getType } from "./metadata.js";

export type Resolved = {
  content: string | Uint8Array;
  type: string;
};

/**
 * `value` as a link, if it is one. A link written as an `ImmutableString`
 * (one op, where a plain string is an op per character) reads back as an
 * object, not a string; it's the same url.
 */
function asLink(value: unknown): AutomergeUrl | undefined {
  const url = isImmutableString(value) ? String(value) : value;
  return typeof url === "string" && isValidAutomergeUrl(url) ? url : undefined;
}

export interface FolderStrategy {
  matches(doc: unknown): boolean;
  resolve(
    repo: Repo,
    handle: DocHandle<unknown>,
    parts: string[],
    visited: Set<string>
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
  async resolve(repo, handle, parts, visited) {
    const folder = handle.doc() as FolderDoc | undefined;
    if (!folder?.docs) return undefined;

    const part = parts[0];
    const docLink = folder.docs.find((doc) => String(doc.name) === part);
    const url = asLink(docLink?.url);
    if (!url) return undefined;

    const next = await repo.find(url);
    return resolvePathInternal(repo, next, parts.slice(1), visited);
  },
};

const directoryStrategy: FolderStrategy = {
  matches(doc) {
    return getType(doc as Parameters<typeof getType>[0]) === "directory";
  },
  async resolve(repo, handle, parts, visited) {
    return walkDirectoryDoc(repo, handle.doc(), parts, visited);
  },
};

async function walkDirectoryDoc(
  repo: Repo,
  node: unknown,
  parts: string[],
  visited: Set<string>
): Promise<Resolved | undefined> {
  const link = asLink(node);
  if (link) {
    // Following a url consumes no parts, so revisiting the same url with the
    // same remaining parts is a cycle.
    const key = `${link}|${parts.join("/")}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const next = await repo.find(link);
    return resolvePathInternal(repo, next, parts, visited);
  }

  if (parts.length === 0) {
    return materialize(repo, node, undefined, visited);
  }

  if (!node || typeof node !== "object" || node instanceof Uint8Array) {
    return undefined;
  }

  // Longest-prefix match: try "main/dist/index.js", then "main/dist", then "main"
  const obj = node as Record<string, unknown>;
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join("/");
    if (key in obj) {
      return walkDirectoryDoc(repo, obj[key], parts.slice(i), visited);
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
  visited: Set<string> = new Set()
): Promise<Resolved | undefined> {
  const link = asLink(node);
  if (link) {
    if (visited.has(link)) return undefined;
    visited.add(link);
    const next = await repo.find(link);
    return materialize(repo, next.doc(), typeHint, visited);
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
    return materialize(repo, obj.content, obj.mimeType ?? typeHint, visited);
  }

  if (node instanceof Uint8Array) {
    return { content: node, type: typeHint ?? "application/octet-stream" };
  }

  // String with a mime hint: pass through. Without: JSON-encode so the response
  // body matches the declared application/json type.
  if (typeof node === "string") {
    if (typeHint) return { content: node, type: typeHint };
    return { content: JSON.stringify(node), type: "application/json" };
  }

  if (isImmutableString(node)) {
    const s = String(node);
    if (typeHint) return { content: s, type: typeHint };
    return { content: JSON.stringify(s), type: "application/json" };
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
  visited: Set<string>
): Promise<Resolved | undefined> {
  if (parts.length === 0) {
    return materialize(repo, handle.doc(), undefined, visited);
  }

  const doc = handle.doc();
  for (const strategy of STRATEGIES) {
    if (strategy.matches(doc)) {
      return strategy.resolve(repo, handle, parts, visited);
    }
  }
  return undefined;
}

export async function resolvePath(
  repo: Repo,
  rootHandle: DocHandle<unknown>,
  parts: string[]
): Promise<Resolved | undefined> {
  return resolvePathInternal(repo, rootHandle, parts, new Set());
}

export type PackageDocument =
  | {
      /** Where in the package it is, `""` for the root. */
      path: string;
      url: AutomergeUrl;
      handle: DocHandle<unknown>;
    }
  | {
      path: string;
      url: AutomergeUrl;
      /** Why it couldn't be found. What it links to isn't walked. */
      error: unknown;
    };

/**
 * Every document in a package that {@link resolvePath} can reach, root first,
 * each found only once it's reached. A caller done with one can let it go
 * before asking for the next: its links have already been read. One that
 * can't be found is handed back with the error, and the walk goes on.
 */
export async function* packageDocuments(
  repo: Repo,
  root: DocHandle<unknown>
): AsyncGenerator<PackageDocument> {
  const seen = new Set<string>([root.documentId]);
  const queue: { path: string; url?: AutomergeUrl }[] = [{ path: "" }];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { path, url = root.url } = next;
    let handle: DocHandle<unknown>;
    try {
      handle = next.url ? await repo.find(next.url) : root;
    } catch (error) {
      yield { path, url, error };
      continue;
    }
    for (const link of linksIn(handle.doc(), path)) {
      const { documentId } = parseAutomergeUrl(link.url);
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      queue.push(link);
    }
    yield { path, url, handle };
  }
}

/** The links out of a directory or folder doc, by the path each is at. */
function linksIn(
  doc: unknown,
  path: string
): { path: string; url: AutomergeUrl }[] {
  const at = (name: string) => (path ? `${path}/${name}` : name);
  if (folderStrategy.matches(doc)) {
    return (doc as FolderDoc).docs.flatMap((link) => {
      const url = asLink(link?.url);
      return url ? [{ path: at(String(link.name)), url }] : [];
    });
  }
  if (!directoryStrategy.matches(doc)) return [];
  const links: { path: string; url: AutomergeUrl }[] = [];
  const walk = (node: unknown, path: string) => {
    const url = asLink(node);
    if (url) links.push({ path, url });
    else if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      !(node instanceof Uint8Array) &&
      !isImmutableString(node)
    ) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}/${key}` : key);
      }
    }
  };
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key !== "@patchwork") walk(value, at(key));
  }
  return links;
}
