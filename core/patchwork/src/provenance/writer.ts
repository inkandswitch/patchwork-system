// Which package version a stack belongs to, and the short key its changes carry.
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { frames } from "./frames.js";

/**
 * A package version (or site build) that writes, and its key. `at` is where
 * in it the write came from: `path:line:column`, the path relative to the
 * package root (the site's path from its origin).
 */
export type Writer = { root: string; key: string; at?: string };

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
  return rootIn(url, ctx.siteOrigin, sourceDirs(ctx.httpSources()))?.root;
}

type SourceDir = { source: string; dir: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Each source with the prefix its frames start with: the source's directory.
 * A source whose directory is a whole host (`https://esm.sh/tldraw@3`,
 * `https://site/tool.js`) would claim every frame on that host, shared code
 * and the site's own included, so it claims only its own file. A loopback dev
 * server is the exception: the whole host is that tool.
 */
function sourceDirs(sources: readonly string[]): SourceDir[] {
  const dirs: SourceDir[] = [];
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      continue;
    }
    const dir = source.slice(0, source.lastIndexOf("/") + 1);
    const wholeHost = dir.length <= url.origin.length + 1;
    dirs.push({ source, dir: wholeHost && !LOOPBACK.has(url.hostname) ? source : dir });
  }
  return dirs;
}

/** The root a frame's url belongs to, and the file's path inside that root. */
function rootIn(
  url: string,
  siteOrigin: string,
  dirs: readonly SourceDir[],
): { root: string | "site"; path: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/");
  for (const [i, segment] of segments.entries()) {
    if (!segment.startsWith("automerge%3A")) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (isValidAutomergeUrl(decoded)) return { root: decoded, path: segments.slice(i + 1).join("/") };
  }
  let best: string | undefined;
  let bestDir = "";
  for (const { source, dir } of dirs) {
    if (
      dir.length > bestDir.length &&
      (dir.endsWith("/") ? url.startsWith(dir) : url === dir)
    ) {
      best = source;
      bestDir = dir;
    }
  }
  // Without the query a dev server adds (`?v=…`, `?t=…`).
  const bare = parsed.origin + parsed.pathname;
  if (best) {
    const path = bestDir.endsWith("/") ? bare.slice(bestDir.length) : segments.at(-1)!;
    return { root: best, path };
  }
  if (parsed.origin === siteOrigin) return { root: "site", path: parsed.pathname.slice(1) };
  return undefined;
}

/**
 * The writer of a captured stack: the first frame that belongs to a package,
 * else the site if any frame was the site's, else null.
 */
export function findWriter(stack: string, ctx: WriterContext): Writer | null {
  let site: string | undefined;
  const dirs = sourceDirs(ctx.httpSources());
  for (const frame of frames(stack)) {
    const found = rootIn(frame.url, ctx.siteOrigin, dirs);
    if (!found) continue;
    const at = `${found.path}:${frame.line}:${frame.column}`;
    if (found.root === "site") site ??= at;
    else return { root: found.root, key: writerKey(found.root), at };
  }
  return site === undefined ? null : { root: ctx.siteRoot, key: writerKey(ctx.siteRoot), at: site };
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
