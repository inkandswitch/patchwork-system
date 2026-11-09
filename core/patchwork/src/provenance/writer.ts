// Which package version a stack belongs to, and the short key its changes carry.
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { frameUrls } from "./frames.js";

/** A package version (or site build) that writes, and its key. */
export type Writer = { root: string; key: string };

export type WriterContext = {
  /** The tab's own origin: frames there with no package segment are the site's. */
  siteOrigin: string;
  /** The root the site's own writes are recorded under, `site@<buildId>`. */
  siteRoot: string;
  /** The http(s) urls plugins were registered from, for dev servers. */
  httpSources: () => readonly string[];
};

/**
 * The package root a frame's url belongs to: a package root, `"site"` for a
 * frame of the site itself, or `undefined` for a frame to skip (a shared CDN,
 * an extension).
 */
export function packageRoot(url: string, ctx: WriterContext): string | "site" | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  for (const segment of parsed.pathname.split("/")) {
    if (!segment.startsWith("automerge%3A")) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (isValidAutomergeUrl(decoded)) return decoded;
  }
  let best: string | undefined;
  let bestDir = "";
  for (const source of ctx.httpSources()) {
    const dir = source.slice(0, source.lastIndexOf("/") + 1);
    if (dir.length > bestDir.length && url.startsWith(dir)) {
      best = source;
      bestDir = dir;
    }
  }
  if (best) return best;
  if (parsed.origin === ctx.siteOrigin) return "site";
  return undefined;
}

/**
 * The writer of a captured stack: the first frame that belongs to a package,
 * else the site if any frame was the site's, else null.
 */
export function findWriter(stack: string, ctx: WriterContext): Writer | null {
  let site = false;
  for (const url of frameUrls(stack)) {
    const root = packageRoot(url, ctx);
    if (root === "site") site = true;
    else if (root !== undefined) return { root, key: writerKey(root) };
  }
  return site ? { root: ctx.siteRoot, key: writerKey(ctx.siteRoot) } : null;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** The longest key there is: 64 bits take 11 base58 characters. */
export const MAX_KEY_LENGTH = 11;
const encoded = new Map<string, string>();

/**
 * The first `length` characters of the base58 64-bit FNV-1a hash of `root`.
 * A longer key extends the shorter one, so a collision grows the key in place.
 * Lengths past MAX_KEY_LENGTH give the whole hash.
 */
export function writerKey(root: string, length = 8): string {
  let full = encoded.get(root);
  if (full === undefined) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(root)) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    full = "";
    for (let i = 0; i < MAX_KEY_LENGTH; i++) {
      full = BASE58[Number(hash % 58n)] + full;
      hash /= 58n;
    }
    encoded.set(root, full);
  }
  return full.slice(0, length);
}
