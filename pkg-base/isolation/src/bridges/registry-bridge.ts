/**
 * Registry bridge — owns *packages*: how a registry (plugin) package is named,
 * located, and served. A package's real location (automerge document ID or
 * external URL) is replaced by an opaque `registry--<sanitized-name>` marker
 * segment so it never crosses into the iframe. The `PackagesUrlMapper` holds this
 * registry-owned mapping; the resource bridge only calls `resolvePackageRequest`.
 *
 * Two phases:
 *  - **registration** (`getRegistries` / `watchRegistries`) — produce serializable
 *    `RegistryEntry`s with `importUrl` mapped to a marker. One memoized
 *    `resolvePackage` per package reads its `package.json` once, resolving the
 *    entry + name and registering its baked automerge dependencies.
 *  - **serve** — `resolvePackageRequest` maps a marker request back to a fetchable
 *    URL; `rewriteServedSource` rewrites baked automerge dep URLs to markers, but
 *    only for packages that declared such deps at registration.
 */

import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import {
  getImportableUrlFromAutomergeUrl,
  resolvePackageExport,
} from "@inkandswitch/patchwork-filesystem";
import { getAllRegistries } from "@inkandswitch/patchwork-plugins";
import type { RegistryEntry } from "../types.js";
import { log } from "../log.js";

/**
 * Prefix of a package marker segment (`registry--<sanitized-name>`). A single
 * path segment with no internal `/`, so it survives the baked-dependency form's
 * `encodeURIComponent` as one segment — see `#markerSegmentFor`.
 */
export const REGISTRY_MARKER_PREFIX = "registry--";

/**
 * A resolved package, discriminated by hosting so the caller can mint its marker
 * without re-scanning a URL:
 *  - **automerge** — bare `automergeUrl` + the entry's `subpath` under the folder
 *    (e.g. `dist/index.js`).
 *  - **external** — the already-resolved `entryUrl` (plain HTTP(S)).
 *
 * Both carry the package `name` (best-effort, for the marker) and
 * `hasAutomergeDeps` (whether `package.json` declared any `automerge:` deps — the
 * serve path's rewrite gate).
 */
type ResolvedPackage = { packageName?: string; hasAutomergeDeps: boolean } & (
  | { hosting: "automerge"; automergeUrl: string; subpath: string }
  | { hosting: "external"; entryUrl: string }
);

/** The subset of a tool package's `package.json` this module reads. */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Split an automerge URL into its base and trailing heads (version) suffix.
 * Automerge URLs may be pinned to specific heads as `automerge:<id>#<heads>`;
 * `isValidAutomergeUrl` only recognizes the base, so callers strip the heads
 * before validating and restore them afterwards.
 */
function stripHeads(segment: string): { base: string; heads: string } {
  const hashIdx = segment.indexOf("#");
  return hashIdx >= 0
    ? { base: segment.slice(0, hashIdx), heads: segment.slice(hashIdx + 1) }
    : { base: segment, heads: "" };
}

/**
 * Split a marker name-part into `{ pkg, heads }`. The heads suffix arrives as `#`
 * (chunk/entry form) or `%23` (double-encoded baked-dependency form) after one
 * decode by `splitFirstSegment`; a sanitized package name contains neither `#`
 * nor `%`, so splitting on whichever appears first is unambiguous. `heads` excludes
 * its marker (empty if unpinned).
 */
function splitMarkerHeads(namepart: string): { pkg: string; heads: string } {
  const hashIdx = namepart.indexOf("#");
  const pctIdx = namepart.indexOf("%23");
  let idx = -1;
  let markerLen = 0;
  if (hashIdx >= 0 && (pctIdx < 0 || hashIdx < pctIdx)) {
    idx = hashIdx;
    markerLen = 1;
  } else if (pctIdx >= 0) {
    idx = pctIdx;
    markerLen = 3;
  }
  return idx < 0
    ? { pkg: namepart, heads: "" }
    : { pkg: namepart.slice(0, idx), heads: namepart.slice(idx + markerLen) };
}

/**
 * Split a URL into its decoded first path segment and the raw remaining path.
 * The shared primitive behind `classify`, `markerNameFromUrl`, and `resolveMarker`
 * for "what is this request for".
 *
 * Security-critical: normalizes via the WHATWG `URL` parser FIRST, so `..`/`.` are
 * collapsed before inspection — a traversal like `<origin>/assets/../automerge:<id>/x`
 * presents `automerge:<id>` as `first` (blocked), rather than sneaking past a raw
 * prefix check. Returns `{ first: "", rest: "" }` if the URL can't be parsed.
 */
export function splitFirstSegment(url: string): { first: string; rest: string } {
  let pathname: string;
  try {
    pathname = new URL(url, window.location.origin).pathname;
  } catch {
    return { first: "", rest: "" };
  }
  const trimmed = pathname.replace(/^\/+/, "");
  const slashIdx = trimmed.indexOf("/");
  const rawFirst = slashIdx < 0 ? trimmed : trimmed.slice(0, slashIdx);
  const rest = slashIdx < 0 ? "" : trimmed.slice(slashIdx + 1);
  let first: string;
  try {
    first = decodeURIComponent(rawFirst);
  } catch {
    first = rawFirst;
  }
  return { first, rest };
}

// ---------------------------------------------------------------------------
// PackagesUrlMapper
// ---------------------------------------------------------------------------

/**
 * Maps real package locations (automerge document IDs or external URLs) to opaque
 * `registry--<name>` marker segments and back. Tool code inside the iframe sees
 * `registry--@patchwork--codemirror-base/dist/index.js`, never a real location —
 * so IDs/locations don't leak, while the marker stays a hierarchical URL for
 * relative import resolution.
 */
export class PackagesUrlMapper {
  #counter = 0;
  // Raw automerge URL → package name (e.g., "automerge:3Dz..." → "@patchwork--folder")
  #automergeToPackage = new Map<string, string>();
  // Package name → raw automerge URL
  #packageToAutomerge = new Map<string, string>();
  // Package name → external package-root URL (ends in "/"), for statically-hosted
  // tools. `resolveMarker` appends the request's subpath to it.
  #packageToExternalRoot = new Map<string, string>();
  // importUrl → memoized `resolvePackage` promise, so a package's `package.json`
  // is read once regardless of how many of its plugins register (boot or live).
  #packageResolution = new Map<
    string,
    Promise<ResolvedPackage | undefined>
  >();
  // Marker names of packages that declared automerge deps — the serve path's
  // rewrite gate. Others are served without a source scan.
  #packagesWithAutomergeDeps = new Set<string>();

  /**
   * Sanitize a package name for use as a URL path segment.
   * "@patchwork/folder" -> "@patchwork--folder"
   */
  #sanitizeName(name: string): string {
    return name.replace(/\//g, "--");
  }

  /**
   * Resolve a package's `importUrl` once (memoized by `importUrl`, so N plugins of
   * one package cost one `package.json` read), reading `package.json` a single
   * time to find the entry + name and register its `automerge:` deps
   * (`#registerAutomergeDeps`). The caller mints the package marker from the result
   * and records it via `markPackageHasDeps` if `hasAutomergeDeps`.
   *
   *  - **automerge** — read the folder's `package.json` and resolve its export;
   *    undefined if unreachable.
   *  - **external** — the importUrl is already the entry; read `package.json` at
   *    the convention-derived root for name + deps (best-effort).
   */
  resolvePackage(importUrl: string): Promise<ResolvedPackage | undefined> {
    let pending = this.#packageResolution.get(importUrl);
    if (!pending) {
      pending = this.#resolvePackageUncached(importUrl);
      this.#packageResolution.set(importUrl, pending);
    }
    return pending;
  }

  async #resolvePackageUncached(
    importUrl: string
  ): Promise<ResolvedPackage | undefined> {
    // External: a manifest `importUrl` is either a package *directory*
    // (`.../tools/<name>/`) or a full entry file (`.../dist/index.js`). Mirror
    // the host loader `httpEntryPointUrl`: a URL that already names a module
    // file is the entry as-is (keep the `!namesModuleFile` guard); otherwise
    // fetch package.json at the root and resolve `exports["."]`/`main`. Without
    // this, `encodeExternal` gets a bare directory, mints an empty subpath, and
    // the iframe imports the 404ing directory. Best-effort: on no package.json
    // or no resolvable entry, keep `importUrl` as the entry.
    if (!isValidAutomergeUrl(importUrl)) {
      const root = packageRootFromUrl(importUrl);
      const pkgJson = root ? await fetchPackageJson(root) : undefined;
      const hasAutomergeDeps = this.#registerAutomergeDeps(pkgJson);
      let entryUrl = importUrl;
      if (!namesModuleFile(importUrl) && pkgJson && root) {
        try {
          const entryPoint = resolvePackageExport(pkgJson);
          if (entryPoint) entryUrl = new URL(entryPoint, root).href;
        } catch {
          // no valid exports/main — keep importUrl as the entry (best-effort)
        }
      }
      return {
        hosting: "external",
        entryUrl,
        packageName: pkgJson?.name,
        hasAutomergeDeps,
      };
    }

    // Automerge: read the folder's package.json, resolve its export. Return the
    // bare automerge URL + entry subpath so the caller mints the marker directly
    // (never embedding the URL just to scan it back out).
    const folderPath = getImportableUrlFromAutomergeUrl(importUrl as AutomergeUrl);
    const base = new URL(folderPath, window.location.origin);
    const pkgJson = await fetchPackageJson(base.href);
    if (!pkgJson) return undefined;

    const entryPoint = resolvePackageExport(pkgJson);
    if (!entryPoint) return undefined;

    // base.href ends in "/<encoded-automerge>/"; the entry resolved against it,
    // minus that prefix, is the subpath (e.g. "dist/index.js").
    const subpath = new URL(entryPoint, base).href.slice(base.href.length);
    const hasAutomergeDeps = this.#registerAutomergeDeps(pkgJson);
    return {
      hosting: "automerge",
      automergeUrl: importUrl,
      subpath,
      packageName: pkgJson.name,
      hasAutomergeDeps,
    };
  }

  /**
   * Register each `automerge:`-valued dependency in `pkgJson` as a dep→marker
   * mapping (for `rewriteAutomergeDepsInSource`), returning whether any were found.
   */
  #registerAutomergeDeps(pkgJson: PackageJson | undefined): boolean {
    let found = false;
    for (const [name, version] of Object.entries(pkgJson?.dependencies ?? {})) {
      const { base } = stripHeads(version);
      if (isValidAutomergeUrl(base)) {
        this.encodeSegment(version, name);
        found = true;
      }
    }
    return found;
  }

  /** Record (by marker name) that a package declared automerge deps, so the serve
   * path rewrites its baked dep literals. */
  markPackageHasDeps(markerName: string): void {
    this.#packagesWithAutomergeDeps.add(markerName);
  }

  /** Whether `markerName`'s package declared automerge deps — the serve-path
   * rewrite gate. */
  packageNeedsRewrite(markerName: string): boolean {
    return this.#packagesWithAutomergeDeps.has(markerName);
  }

  /** The marker name (`registry--<sanitized-name>`) a package maps under, from its
   * package name. Keys `markPackageHasDeps` / `packageNeedsRewrite`. */
  markerNameFor(name: string): string {
    return `${REGISTRY_MARKER_PREFIX}${this.#sanitizeName(name)}`;
  }

  /**
   * Register an automerge base under a package name (reusing an existing mapping)
   * and return its marker segment, carrying heads as a `%23<heads>` suffix.
   *
   * Single-segment `registry--<name>` (not `registry/<name>`, not a `pkg:` scheme)
   * is required: the baked-dependency form is `encodeURIComponent`d whole by
   * `getImportableUrlFromAutomergeUrl`, and a segment with no internal `/` survives
   * as one segment — so chunk and dependency forms alike present the marker as the
   * first path segment, and `classify` / `resolveMarker` treat every request
   * uniformly.
   */
  #markerSegmentFor(base: string, heads: string, name?: string): string {
    let pkg = this.#automergeToPackage.get(base);
    if (!pkg) {
      pkg = name ? this.#sanitizeName(name) : `unknown-${this.#counter++}`;
      this.#automergeToPackage.set(base, pkg);
      this.#packageToAutomerge.set(pkg, base);
    }
    const marker = `${REGISTRY_MARKER_PREFIX}${pkg}`;
    return heads ? `${marker}%23${heads}` : marker;
  }

  /**
   * Has this automerge base been registered as a dependency? The source rewrite's
   * allowlist: only registered dep URLs are rewritten to markers; a URL a tool
   * fabricated is left raw, so its request stays a raw automerge path `classify`
   * blocks.
   */
  isRegisteredDependency(base: string): boolean {
    return this.#automergeToPackage.has(base);
  }

  /**
   * ENCODE (automerge → marker). Map a bare automerge URL (e.g.
   * `automerge:HaCFn…#26oUrk…`) to its bare marker segment
   * (`registry--@chee--patchwork-llm%2326oUrk…`), registering the mapping if new.
   * The single automerge-encoding primitive — used for both package entries and
   * baked `package.json` dependency URLs; the caller (or a runtime
   * `getImportableUrlFromAutomergeUrl` call) appends a subpath and origin-prefixes
   * it, and `resolveMarker` reverses the result. Returns null if not a valid
   * automerge URL.
   */
  encodeSegment(folderUrl: string, name?: string): string | null {
    const { base, heads } = stripHeads(folderUrl);
    if (!isValidAutomergeUrl(base)) return null;
    return this.#markerSegmentFor(base, heads, name);
  }

  /**
   * ENCODE (external → marker). Map a statically-hosted package entry URL to a
   * host-origin `registry--<name>` marker URL, registering the package root
   * (derived via `packageRootFromUrl`) if new, so the external location never
   * crosses into the iframe:
   * `https://netlify.app/tool/dist/index.js` → `<origin>/registry--<name>/dist/index.js`.
   * `name` is the package name, so a package's plugins share one marker. Chunk
   * requests under the marker reverse via `resolveMarker`. Returns `entryUrl`
   * unchanged if its root can't be derived.
   */
  encodeExternal(entryUrl: string, name: string): string {
    const root = packageRootFromUrl(entryUrl);
    if (!root) return entryUrl;

    const pkg = this.#sanitizeName(name);
    if (!this.#packageToExternalRoot.has(pkg)) {
      this.#packageToExternalRoot.set(pkg, root);
    }
    const marker = `${REGISTRY_MARKER_PREFIX}${pkg}`;
    // entryUrl starts with root (root came from it), so this is a prefix swap.
    const subpath = entryUrl.startsWith(root) ? entryUrl.slice(root.length) : "";
    return `${window.location.origin}/${marker}/${subpath}`;
  }

  /**
   * RESOLVE (marker → real location). Turn an inbound `registry--<name>` marker
   * request into the real fetchable location — an automerge path (SW-resolvable)
   * or an external URL (fetched directly); null if it carries no known marker.
   *
   * The marker is always the request's first path segment, so we parse it and look
   * the package up by exact name — no scan. A package is in exactly one map;
   * automerge is checked first only for precedence.
   */
  resolveMarker(url: string): string | null {
    const { first, rest } = splitFirstSegment(url);
    if (!first.startsWith(REGISTRY_MARKER_PREFIX)) return null;
    const { pkg, heads } = splitMarkerHeads(
      first.slice(REGISTRY_MARKER_PREFIX.length)
    );

    // Automerge: the real automerge URL (+ heads), URL-encoded as the first path
    // segment, then the subpath — the SW-resolvable form.
    const automergeUrl = this.#packageToAutomerge.get(pkg);
    if (automergeUrl !== undefined) {
      const full = heads ? `${automergeUrl}#${heads}` : automergeUrl;
      return `${encodeURIComponent(full)}/${rest}`;
    }

    // External: the registered root (ends in "/") + the subpath.
    const root = this.#packageToExternalRoot.get(pkg);
    if (root !== undefined) return `${root}${rest}`;

    return null;
  }

}

// ---------------------------------------------------------------------------
// Package entry resolution
// ---------------------------------------------------------------------------

/** Bundler output directory names an entry point commonly sits under. */
const BUNDLE_OUTPUT_DIRS = new Set(["dist", "build", "out", "lib"]);

/** Extensions marking a URL as a direct entry point vs. a package/site root. */
const MODULE_FILE_EXTENSION = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;

// TODO: this duplicates `patchwork-filesystem`'s internal `httpEntryPointUrl`
// (same regex + package.json-entry resolution). Delegate to it once that helper
// is exported, instead of maintaining a parallel copy here.
/** Whether a URL's pathname already names a module file (a direct entry). */
function namesModuleFile(moduleUrl: string): boolean {
  try {
    return MODULE_FILE_EXTENSION.test(new URL(moduleUrl, window.location.origin).pathname);
  } catch {
    return false;
  }
}

/**
 * Derive a module URL's package-root directory (ends in "/") by the publish
 * convention: bundled tools serve code under `<pkgroot>/dist/…` alongside
 * `<pkgroot>/package.json`. The root is the parent of the nearest bundler-output
 * dir (`dist`/`build`/…) in the path, or the module's own directory if none.
 * Stable across a package's chunks. Returns null if the URL can't be parsed.
 */
function packageRootFromUrl(moduleUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(moduleUrl, window.location.origin);
  } catch {
    return null;
  }
  const segments = base.pathname.split("/").filter(Boolean);
  // Drop the filename; look for the nearest bundler-output dir among the path
  // dirs and treat its parent as the package root.
  const dirs = segments.slice(0, -1);
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (BUNDLE_OUTPUT_DIRS.has(dirs[i])) {
      const rootPath = dirs.slice(0, i).join("/");
      return new URL(`/${rootPath}${rootPath ? "/" : ""}`, base.origin).href;
    }
  }
  // No bundler dir in the path — the module's own directory is the root.
  return new URL(".", base).href;
}

// ---------------------------------------------------------------------------
// Source rewriting
// ---------------------------------------------------------------------------

/**
 * Fetch and parse `package.json` from an already-derived package-root URL.
 * Returns undefined if none is found or on any error.
 */
async function fetchPackageJson(
  packageRoot: string
): Promise<PackageJson | undefined> {
  let candidate: string;
  try {
    candidate = new URL("package.json", packageRoot).href;
  } catch {
    return undefined;
  }
  try {
    const response = await fetch(candidate);
    if (response.ok) return await response.json();
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Matches an `automerge:` URL (base + optional `#<heads>`) embedded in served
 * source. The `[A-Za-z0-9]` alphabet is what `isValidAutomergeUrl` accepts and
 * stops at the closing quote/paren; each match is re-validated before use, so an
 * over-match is harmless.
 */
const AUTOMERGE_URL_IN_SOURCE = /automerge:[A-Za-z0-9]+(?:#[A-Za-z0-9]+)?/g;

/**
 * Prepare a served registry module's source for the iframe: rewrite baked
 * `automerge:` dep literals to markers, but only if the owning package (identified
 * by `requestUrl`'s marker name) declared automerge deps at registration — so
 * most served modules skip the source scan entirely. The serve-time source entry
 * point the resource bridge calls.
 */
export function rewriteServedSource(
  source: string,
  requestUrl: string,
  mapper: PackagesUrlMapper
): string {
  const markerName = markerNameFromUrl(requestUrl);
  if (!markerName || !mapper.packageNeedsRewrite(markerName)) return source;
  return rewriteAutomergeDepsInSource(source, mapper);
}

/**
 * Rewrite baked `automerge:` dependency literals in served source to `registry--`
 * markers before the source crosses into the iframe.
 *
 * Tools built with `@chee/patchwork-bundles` bake a dep's automerge URL into the
 * source (handed to `getImportableUrlFromAutomergeUrl` at runtime). Left alone it
 * leaks the ID and yields a raw-automerge request `classify` blocks; rewritten to
 * a marker, the runtime call instead produces a marker request `resolveMarker`
 * maps back. The **mapper is the allowlist**: only an already-registered dep base
 * is rewritten (registration precedes any serve), so a URL a tool fabricated for
 * some other document is left raw and blocked like any smuggled ID.
 */
function rewriteAutomergeDepsInSource(
  source: string,
  mapper: PackagesUrlMapper
): string {
  return source.replace(AUTOMERGE_URL_IN_SOURCE, (match) => {
    const { base } = stripHeads(match);
    if (!mapper.isRegisteredDependency(base)) return match;
    const marker = mapper.encodeSegment(match);
    return marker ?? match;
  });
}

/**
 * Extract the `registry--<name>` marker name (decoded first path segment, heads
 * stripped) from a request URL, or null if it has none. Identifies the package
 * that owns a served module.
 *
 * A heads-pinned request arrives as `registry--@scope--name%23<heads>`, but
 * `markPackageHasDeps` records the bare name, so without stripping
 * `packageNeedsRewrite` misses and the iframe allowlist blocks the tool's
 * automerge deps.
 */
function markerNameFromUrl(url: string): string | null {
  const { first } = splitFirstSegment(url);
  if (!first.startsWith(REGISTRY_MARKER_PREFIX)) return null;
  const { pkg } = splitMarkerHeads(first.slice(REGISTRY_MARKER_PREFIX.length));
  return `${REGISTRY_MARKER_PREFIX}${pkg}`;
}

// ---------------------------------------------------------------------------
// Request resolution (the interface the resource bridge calls)
// ---------------------------------------------------------------------------

/**
 * Resolve an inbound `registry` request (a `registry--` marker URL) to a fetchable
 * URL — the read side the resource bridge calls after `classify` admits it. A
 * marker arrives either as a chunk/entry path
 * (`<origin>/registry--@scope--name/dist/chunk.js`) or the baked-dependency form
 * where `getImportableUrlFromAutomergeUrl` percent-encoded the bare marker
 * (`<origin>/registry--%40scope--name%2523h/sub`); `resolveMarker` handles both.
 * A non-marker URL (a platform asset) is returned unchanged.
 */
export function resolvePackageRequest(
  url: string,
  mapper: PackagesUrlMapper
): string {
  return mapper.resolveMarker(url) ?? url;
}

// ---------------------------------------------------------------------------
// Registry population (boot + live updates)
// ---------------------------------------------------------------------------

/**
 * Convert a host registry plugin into a serializable `RegistryEntry` for the
 * iframe: resolve its `importUrl` (via the memoized `mapper.resolvePackage`, which
 * also registers the package's automerge deps in the same read), map it to a
 * `registry--` marker (automerge via `encodeSegment`, external via `encodeExternal`
 * — both keyed by package name so a package's plugins share one marker), record
 * the package if it declared deps, and strip non-cloneable fields + deep-copy so
 * the entry survives `postMessage`.
 *
 * Returns `undefined` (and logs) if the plugin can't be cloned. Shared by
 * `getRegistries` and `watchRegistries` so both produce entries identically.
 */
async function processRegistryPlugin(
  plugin: any,
  mapper: PackagesUrlMapper
): Promise<RegistryEntry | undefined> {
  let importUrl = plugin.importUrl as string | undefined;
  if (importUrl) {
    const resolved = await mapper.resolvePackage(importUrl);
    if (!resolved) {
      importUrl = undefined;
    } else {
      // Marker keyed by package name (plugins of a package share one marker),
      // falling back to the plugin id if package.json had no name.
      const name = resolved.packageName ?? plugin.id;
      if (resolved.hosting === "automerge") {
        // `<origin>/registry--<name>/<subpath>` from the bare automerge URL.
        const marker = mapper.encodeSegment(resolved.automergeUrl, name);
        importUrl = marker
          ? `${window.location.origin}/${marker}/${resolved.subpath}`
          : undefined;
      } else {
        importUrl = mapper.encodeExternal(resolved.entryUrl, name);
      }
      // Record (by the same marker name) so the serve path rewrites this
      // package's baked dep literals.
      if (resolved.hasAutomergeDeps) {
        mapper.markPackageHasDeps(mapper.markerNameFor(name));
      }
    }
  }

  const { load, module, ...rest } = plugin;
  let entry: RegistryEntry;
  try {
    entry = structuredClone(rest);
  } catch (err) {
    log(`skipping non-cloneable plugin: ${rest.id}`, err);
    return undefined;
  }
  entry.importUrl = importUrl;
  return entry;
}

/**
 * Collect registry entries from all plugin registries (with importUrls mapped to
 * `registry--` marker URLs) for the iframe's initial registry population.
 */
export async function getRegistries(
  mapper: PackagesUrlMapper
): Promise<RegistryEntry[]> {
  const entries: RegistryEntry[] = [];
  for (const [, registry] of getAllRegistries()) {
    for (const plugin of registry.all()) {
      const entry = await processRegistryPlugin(plugin, mapper);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Watch all host registries for new plugin registrations and push each (as a
 * mapped, serializable entry) to the iframe via the RPC port.
 *
 * Returns a cleanup function that unsubscribes from all registries.
 */
export function watchRegistries(
  port: MessagePort,
  mapper: PackagesUrlMapper
): () => void {
  const unsubs: Array<() => void> = [];

  for (const [, registry] of getAllRegistries()) {
    const unsub = registry.on("registered", async (plugin: any) => {
      const entry = await processRegistryPlugin(plugin, mapper);
      if (!entry) return;
      log(`pushing registry update: ${entry.id}`);
      port.postMessage({ type: "plugin-registered", entry });
    });
    unsubs.push(unsub);
  }

  return () => {
    for (const unsub of unsubs) unsub();
  };
}
