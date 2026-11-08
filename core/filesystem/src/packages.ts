import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { resolve } from "resolve.exports";
import debug from "debug";
import {
  documentBaseOrigin,
  getImportableUrlFromAutomergeUrl,
} from "./urls.js";
const log = debug("patchwork:filesystem");

export const defaultImportConditions = ["patchwork", "browser", "import"];

// A failed import is memoized in the ES module map against its URL, so the
// same URL can never be retried in this realm. Retrying under a distinct URL
// gets a fresh entry; the heads-pinned URLs make it safe, since the content at
// a given set of heads can't change.
async function importModule(entryPointUrl: string) {
  try {
    return await import(/* @vite-ignore */ entryPointUrl);
  } catch (cause) {
    const retry = new URL(entryPointUrl);
    retry.searchParams.set("retry", "1");
    log(`retrying ${entryPointUrl.slice(-60)}`);
    try {
      return await import(/* @vite-ignore */ retry.href);
    } catch {
      throw cause;
    }
  }
}

export async function importPackageFromFolderDocUrl(
  folderDocUrl: AutomergeUrl,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
) {
  log(`importPackage ${folderDocUrl}... (subpath: ${subpath})`);
  const entryPointUrl = await packageEntryPointUrl(
    folderDocUrl,
    subpath,
    conditions
  );
  if (!entryPointUrl) {
    throw new Error(
      `No entry point found for subpath "${subpath}" in package.json`
    );
  }

  log(`importing ${entryPointUrl.slice(-60)}`);

  return await importModule(entryPointUrl);
}

export async function importPackageFromHttpUrl(
  url: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
) {
  const entryPointUrl = await httpEntryPointUrl(url, subpath, conditions);
  log(`importing ${entryPointUrl.slice(-60)}`);
  return await importModule(entryPointUrl);
}

/**
 * An `automerge:` URL is imported as given, not pinned to heads: pin it first
 * if the version matters, as {@link ModuleWatcher} does.
 */
export async function importPackage(
  url: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
) {
  return isValidAutomergeUrl(url)
    ? importPackageFromFolderDocUrl(url, subpath, conditions)
    : importPackageFromHttpUrl(url, subpath, conditions);
}

// Module file extensions that mark a URL as a direct entry point rather than a
// package/site root to look for a `package.json` in.
const MODULE_FILE_EXTENSION = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;

async function httpEntryPointUrl(
  url: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
): Promise<string> {
  // Absolute URLs (http(s), data:, blob:) resolve on their own; only a relative
  // URL needs the document base, which isn't available off the main thread.
  let resolved: URL;
  try {
    resolved = new URL(url);
  } catch {
    resolved = new URL(url, documentBaseOrigin());
  }
  // Only http(s) directories get a package.json probe. A module file, or a
  // `data:`/`blob:` module, is imported as given.
  const isHttp =
    resolved.protocol === "http:" || resolved.protocol === "https:";
  if (!isHttp || MODULE_FILE_EXTENSION.test(resolved.pathname)) {
    return resolved.href;
  }

  // Treat the URL as a directory: resolve `package.json` against it with a
  // trailing slash so its last path segment isn't dropped.
  const base = resolved.href.endsWith("/")
    ? resolved.href
    : `${resolved.href}/`;
  const packageJsonUrl = new URL("package.json", base).href;

  log(`fetching ${packageJsonUrl.slice(-60)}`);

  // A rejected fetch is a real failure (offline, DNS, or most often CORS: no
  // `Access-Control-Allow-Origin`), not "no package.json here". Don't fall back
  // to importing the bare URL: the same wall blocks the `import()` too.
  let response: Response;
  try {
    response = await fetch(packageJsonUrl);
  } catch (cause) {
    // Reading the document's origin can throw off the main thread; don't let
    // that hide `cause`.
    let origin: string | undefined;
    try {
      origin = documentBaseOrigin();
    } catch {}
    const crossOrigin = origin !== undefined && resolved.origin !== origin;
    const hint = crossOrigin
      ? `This is a cross-origin request (${origin} → ${resolved.origin}), so it's most likely blocked by CORS: the host must send an \`Access-Control-Allow-Origin\` header, and a cross-origin module can't be imported without one.`
      : `This is usually a network error (offline/unreachable) or a cross-origin request blocked by CORS (a missing \`Access-Control-Allow-Origin\` header).`;
    throw new Error(
      `Couldn't fetch ${packageJsonUrl} to resolve the module entry point. ${hint}`,
      { cause }
    );
  }

  // Not a package root (usually a 404), so import it directly: a directory
  // that serves an `index.js` works.
  if (!response.ok) {
    log(
      `no package.json at ${packageJsonUrl} (HTTP ${response.status}); importing ${resolved.href} directly`
    );
    return resolved.href;
  }

  let pkgJson: Record<string, any>;
  try {
    pkgJson = await response.json();
  } catch (cause) {
    throw new Error(`Fetched ${packageJsonUrl} but couldn't parse it as JSON`, {
      cause,
    });
  }

  const entryPoint = resolvePackageExport(pkgJson, subpath, conditions);
  return new URL(entryPoint, base).href;
}

/**
 * Import the entry point of a package (at `folderDocUrl`, pinned to heads) and
 * return the loaded implementation of one plugin it exports, picked by
 * `pluginType` and `pluginId`: an id is only unique within a type.
 *
 * The main-thread half of discovering plugins in a worker: the worker says
 * which plugins a package exports, and this runs one's own `load()` or
 * `import`, so its description and implementation come from the same version.
 */
export async function importPluginFromFolderDocUrl(
  folderDocUrl: AutomergeUrl,
  pluginType: string,
  pluginId: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
) {
  const mod = await importPackageFromFolderDocUrl(
    folderDocUrl,
    subpath,
    conditions
  );
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const plugin = plugins.find(
    (p) => p?.type === pluginType && p?.id === pluginId
  );
  if (!plugin) {
    throw new Error(
      `No plugin "${pluginType}:${pluginId}" exported by the package at ${folderDocUrl}`
    );
  }
  if (typeof plugin.load === "function") {
    return plugin.load();
  }
  if (typeof plugin.import === "string") {
    return import(/* @vite-ignore */ plugin.import);
  }
  throw new Error(
    `Plugin "${pluginType}:${pluginId}" at ${folderDocUrl} has no load() function or import URL`
  );
}

async function packageJsonContentsFromFolderDocUrl(
  folderDocUrl: AutomergeUrl
): Promise<Record<string, any>> {
  const packageJSONPath = new URL(
    "package.json",
    new URL(
      getImportableUrlFromAutomergeUrl(folderDocUrl),
      documentBaseOrigin()
    )
  ).href;

  log(`fetching ${packageJSONPath.slice(-60)}`);

  let response: Response;
  try {
    response = await fetch(packageJSONPath);
  } catch (cause) {
    throw new Error(
      `Couldn't fetch ${packageJSONPath} for ${folderDocUrl} — a network error, or the service worker isn't serving automerge module URLs`,
      { cause }
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${packageJSONPath} for ${folderDocUrl}: HTTP ${response.status}`
    );
  }
  log(`package.json OK for ${folderDocUrl.slice(0, 25)}...`);
  return response.json();
}

export function resolvePackageExport(
  pkgJson: Record<string, any>,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
): string {
  try {
    const resolved = resolve(pkgJson, subpath, { conditions });
    if (resolved) return resolved[0];
  } catch {}

  if (subpath === "." && typeof pkgJson.main === "string") {
    return pkgJson.main;
  }

  throw new Error(
    `No valid 'exports' for "${subpath}" or 'main' in package.json`
  );
}

async function packageEntryPointUrl(
  folderDocUrl: AutomergeUrl,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions
) {
  const pkgJson = await packageJsonContentsFromFolderDocUrl(folderDocUrl);

  const entryPoint = resolvePackageExport(pkgJson, subpath, conditions);
  if (!entryPoint) return undefined;

  const base = new URL(
    getImportableUrlFromAutomergeUrl(folderDocUrl),
    documentBaseOrigin()
  );

  const entry = new URL(entryPoint, base);

  return entry.href;
}
