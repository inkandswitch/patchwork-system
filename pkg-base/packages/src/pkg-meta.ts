// Resolve the package.json behind an importUrl so a group of plugins can be
// named like a package rather than by a raw URL.
//
//   • automerge: URL  → the folder doc is served by the site's service worker;
//     map the URL to its servable base with the filesystem package's own
//     importer (getImportableUrlFromAutomergeUrl) and fetch package.json.
//   • http(s):// URL  → the importUrl points at the module's entry file, so
//     package.json sits next to it: `new URL("package.json", importUrl)`.
//   • bare specifier  → nothing to fetch; the specifier is the name.
//
// Everything is best-effort: any failure falls back to a readable label derived
// from the URL. Nothing is cached here: the packages view asks once per
// importUrl per mount.

import { getImportableUrlFromAutomergeUrl } from "@inkandswitch/patchwork-filesystem";
import { isAutomergeUrl, isHttpUrl } from "./origin.ts";

export interface PkgMeta {
  name?: string;
  title?: string;
  version?: string;
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

function pickMeta(pkg: any): PkgMeta {
  return {
    name: typeof pkg?.name === "string" ? pkg.name : undefined,
    title: typeof pkg?.title === "string" ? pkg.title : undefined,
    version: typeof pkg?.version === "string" ? pkg.version : undefined,
  };
}

// Build-output / source folders that aren't the package's real name — an
// importUrl of `.../comments-view/dist/index.js` should read as "comments-view",
// not "dist". Used both to walk up looking for package.json and to derive the
// fallback label.
const BUILD_DIRS = new Set([
  "dist",
  "build",
  "lib",
  "out",
  "es",
  "esm",
  "cjs",
  "umd",
  "src",
  "public",
  "www",
]);

/** The path segments of an http(s) URL with any trailing entry file dropped. */
function dirSegments(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (/\.[a-z0-9]+$/i.test(last)) parts.pop();
  return parts;
}

/** Is the last segment a build-output dir (dist/, build/, …)? */
function endsInBuildDir(parts: string[]): boolean {
  return parts.length > 0 && BUILD_DIRS.has(parts[parts.length - 1].toLowerCase());
}

/** A lightweight plugin description read from a package.json `plugins` array. */
export interface PluginLite {
  id?: string;
  name?: string;
  type?: string;
  supportedDatatypes?: string | string[];
  unlisted?: boolean;
}

export interface PkgInfo {
  meta: PkgMeta;
  /** Plugins declared in package.json, or null if none/unreadable. */
  plugins: PluginLite[] | null;
}

function pickPlugins(pkg: any): PluginLite[] | null {
  const arr = pkg?.plugins;
  if (!Array.isArray(arr)) return null;
  return arr
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      id: typeof p.id === "string" ? p.id : undefined,
      name: typeof p.name === "string" ? p.name : undefined,
      type: typeof p.type === "string" ? p.type : undefined,
      supportedDatatypes: p.supportedDatatypes,
      unlisted: p.unlisted === true ? true : undefined,
    }));
}

/** Fetch the raw package.json behind an importUrl (automerge or http), if any. */
export async function resolvePackageJson(
  importUrl: string
): Promise<any | undefined> {
  if (isAutomergeUrl(importUrl)) {
    // The filesystem package's importer returns the service-worker-servable base
    // for the folder doc, resolved to an absolute URL (against the document
    // base), so package.json resolves correctly even inside a sandboxed/srcdoc
    // frame where `location.origin` is the string "null".
    // Cast via the importer's own parameter type so we don't pull the
    // `AutomergeUrl` brand (and its automerge-repo dts) into this tool's deps.
    const base = getImportableUrlFromAutomergeUrl(
      importUrl as Parameters<typeof getImportableUrlFromAutomergeUrl>[0]
    );
    const pkgUrl = new URL("package.json", base).href;
    return fetchJson(pkgUrl);
  }

  if (isHttpUrl(importUrl)) {
    try {
      const u = new URL(importUrl);
      // Try package.json beside the entry file, then walk up past build-output
      // dirs (dist/, build/, …) to the tool root, where package.json usually is.
      const dirs = dirSegments(u);
      const candidates: string[] = [dirs.join("/")];
      while (endsInBuildDir(dirs)) {
        dirs.pop();
        candidates.push(dirs.join("/"));
      }
      for (const dir of candidates) {
        const base = `${u.origin}/${dir}${dir ? "/" : ""}`;
        const pkg = await fetchJson(new URL("package.json", base).href);
        if (pkg && (pkg.name || pkg.title || Array.isArray(pkg.plugins)))
          return pkg;
      }
    } catch {
      // fall through
    }
  }

  return undefined;
}

export async function resolvePackageMeta(importUrl: string): Promise<PkgMeta> {
  return pickMeta((await resolvePackageJson(importUrl)) ?? {});
}

/** Both the display meta and the declared plugins, from one package.json fetch. */
export async function resolvePackageInfo(importUrl: string): Promise<PkgInfo> {
  const pkg = await resolvePackageJson(importUrl);
  return { meta: pickMeta(pkg ?? {}), plugins: pickPlugins(pkg) };
}

function shortenAutomerge(url: string): string {
  const id = url.slice("automerge:".length).replace(/[@?#].*$/, "");
  return id.length > 10 ? `automerge:${id.slice(0, 8)}…` : url;
}

/** A human label for a package group, from its meta with URL-derived fallback. */
export function packageDisplayName(
  importUrl: string | undefined,
  meta: PkgMeta | undefined
): string {
  if (meta?.title) return meta.title;
  if (meta?.name) return meta.name;
  if (!importUrl) return "(unknown source)";
  if (isAutomergeUrl(importUrl)) return shortenAutomerge(importUrl);
  if (isHttpUrl(importUrl)) {
    try {
      const u = new URL(importUrl);
      // Drop the entry file, then walk up past build-output dirs (dist/, …) so
      // `.../comments-view/dist/index.js` reads as "comments-view", not "dist".
      const parts = dirSegments(u);
      while (endsInBuildDir(parts)) parts.pop();
      return parts[parts.length - 1] || u.hostname;
    } catch {
      return importUrl;
    }
  }
  return importUrl; // bare specifier — already a name
}
