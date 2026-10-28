import {
  type DocumentId,
  type UrlHeads,
  isValidDocumentId,
} from "@automerge/automerge-repo/slim";
import bs58 from "bs58";

/**
 * A step that enters a document at given heads: `<idhash>@<heads>`, or
 * `<idhash>@<heads>~<listHash>` for a container whose files the URL names by their list (see
 * file-list.ts). `raw` is the segment as written, so a walk that finds no link with this idhash
 * can read it as a name instead.
 */
export type DocStep = {
  kind: "doc";
  idhash: string;
  heads: UrlHeads;
  listHash?: string;
  raw: string;
};
export type NameStep = { kind: "name"; name: string };
export type Segment = DocStep | NameStep;

/**
 * Where a path starts: an account the resolver knows by its idhash, or (for a portable share
 * link) a document named by its id. A share root is always pinned.
 */
export type PathRoot =
  | { kind: "account"; acctHash: string; heads?: UrlHeads; listHash?: string }
  | { kind: "share"; documentId: DocumentId; heads: UrlHeads; listHash?: string };

export type ParsedPath = { root: PathRoot; segments: Segment[] };

export class PathSyntaxError extends Error {
  name = "PathSyntaxError";
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHARE_PREFIX = "automerge:";

/**
 * The first 12 bytes of SHA-256 over the UTF-8 of a document id, in base58. It tells a document
 * from its siblings and keeps the id out of URLs. It is not a secret.
 */
export async function idhash(documentId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(documentId)
  );
  return bs58.encode(new Uint8Array(digest).slice(0, 12));
}

/** Heads sorted and joined with `.`, so one set of heads is one string. */
export function formatHeads(heads: readonly string[]): string {
  return [...heads].sort().join(".");
}

export function parseHeads(segment: string): UrlHeads | undefined {
  const parts = segment.split(".");
  if (!parts.every((part) => BASE58.test(part))) return undefined;
  return parts.sort() as UrlHeads;
}

export function docStep(
  idhash: string,
  heads: readonly string[],
  listHash?: string
): string {
  return `${idhash}@${formatHeads(heads)}${listHash ? `~${listHash}` : ""}`;
}

export function livePath(acctHash: string, names: string[]): string {
  return [acctHash, ...names.map(encodeURIComponent)].join("/");
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new PathSyntaxError(`malformed escape in path segment ${raw}`);
  }
}

/** `<heads>` or `<heads>~<listHash>`, split, or undefined if it isn't that shape. */
function splitHeads(
  text: string
): { heads: UrlHeads; listHash?: string } | undefined {
  const tilde = text.indexOf("~");
  const heads = parseHeads(tilde < 0 ? text : text.slice(0, tilde));
  if (!heads) return undefined;
  if (tilde < 0) return { heads };
  const listHash = text.slice(tilde + 1);
  return BASE64URL.test(listHash) ? { heads, listHash } : undefined;
}

/** `<base58>@<heads>[~<listHash>]`, split, or undefined if it isn't that shape. */
function splitDocStep(
  raw: string
): { id: string; heads: UrlHeads; listHash?: string } | undefined {
  const at = raw.indexOf("@");
  if (at < 0) return undefined;
  const id = raw.slice(0, at);
  const rest = splitHeads(raw.slice(at + 1));
  if (!BASE58.test(id) || !rest) return undefined;
  return { id, ...rest };
}

function parseRoot(raw: string): PathRoot {
  const decoded = decode(raw);
  if (decoded.startsWith(SHARE_PREFIX)) {
    const rest = decoded.slice(SHARE_PREFIX.length);
    const at = rest.lastIndexOf("@");
    const documentId = rest.slice(0, at);
    const pinned = at < 0 ? undefined : splitHeads(rest.slice(at + 1));
    if (!pinned || !isValidDocumentId(documentId)) {
      throw new PathSyntaxError(
        `a share link must be automerge:<documentId>@<heads>, got ${decoded}`
      );
    }
    return { kind: "share", documentId, ...pinned };
  }
  if (BASE58.test(raw)) return { kind: "account", acctHash: raw };
  const step = splitDocStep(raw);
  if (!step) {
    throw new PathSyntaxError(
      `a path must start with an account hash or a share link, got ${raw}`
    );
  }
  return {
    kind: "account",
    acctHash: step.id,
    heads: step.heads,
    ...(step.listHash ? { listHash: step.listHash } : {}),
  };
}

/**
 * Read a live or pinned path. Segments are percent-encoded and split on literal slashes; a
 * segment with a literal `@` that parses as `<base58>@<heads>` is a doc step, everything else a
 * name. Whether a doc step really is one is the walk's call, since only it can see the links.
 */
export function parsePath(path: string): ParsedPath {
  const [first, ...rest] = path.split("/").filter(Boolean);
  if (!first) throw new PathSyntaxError("empty path");
  const segments = rest.map((raw): Segment => {
    const step = splitDocStep(raw);
    return step
      ? {
          kind: "doc",
          idhash: step.id,
          heads: step.heads,
          ...(step.listHash ? { listHash: step.listHash } : {}),
          raw,
        }
      : { kind: "name", name: decode(raw) };
  });
  return { root: parseRoot(first), segments };
}
