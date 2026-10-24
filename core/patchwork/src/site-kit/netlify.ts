import type { PatchworkSiteOptions } from "./options.js";
import { resolveSyncServers, PRELOAD_WASM_ASSETS } from "./sync-servers.js";

/**
 * Files a build emits at a fixed path whose copy the browser may start from
 * when it can't check for a newer one, so they start offline: a worker's
 * script, which every build is started by. All it imports is its own build's
 * hashed files, so a copy from an older build still brings up a whole build.
 * The service worker isn't here: the browser checks it for updates past its
 * cache.
 */
export const REVALIDATED_PATHS = ["/automerge-protocol-handler-worker.js"];

export const REVALIDATED_CACHE_CONTROL =
  "public, max-age=0, stale-while-revalidate=31536000";

function buildLinkHeader(
  syncServers: string[],
  hashed: ReadonlyMap<string, string>
): string {
  const parts = PRELOAD_WASM_ASSETS.map(
    (asset) =>
      `<${hashed.get(`/${asset}`) ?? `/${asset}`}>; rel=preload; as=fetch; crossorigin`
  );
  for (const server of syncServers) {
    parts.push(`<${server}>; rel=preconnect`);
  }
  for (const server of syncServers) {
    parts.push(`<${server}>; rel=dns-prefetch`);
  }
  return parts.join(", ");
}

/**
 * Builds the generated Netlify _headers file content — no bundler involved.
 * `hashed` is each fixed path the build emitted under a hashed name, with
 * that name's URL, so the preloads name the file the page will fetch.
 */
export function buildHeaders(
  options: PatchworkSiteOptions,
  hashed: ReadonlyMap<string, string> = new Map()
): string {
  const syncServers = resolveSyncServers(options);
  const immutableAssets =
    options.netlify === false || options.netlify?.immutableAssets === false
      ? null
      : "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

  return [
    "/*\n  Access-Control-Allow-Origin: *",
    immutableAssets,
    ...REVALIDATED_PATHS.map(
      (path) => `${path}\n  Cache-Control: ${REVALIDATED_CACHE_CONTROL}\n`
    ),
    `/\n  Link: ${buildLinkHeader(syncServers, hashed)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The SPA fallback every generated _redirects file ends with. */
export const REDIRECTS = "/* /index.html 200\n";

/**
 * The generated Netlify _redirects file content: from each fixed path the
 * build emitted under a hashed name (see buildHeaders) to that name, for code
 * that still asks for the fixed path, then the SPA fallback. A 302, since a
 * browser keeps a 301 and the next build's file is somewhere else.
 */
export function buildRedirects(
  hashed: ReadonlyMap<string, string> = new Map()
): string {
  return (
    [...hashed].map(([path, url]) => `${path} ${url} 302\n`).join("") +
    REDIRECTS
  );
}
