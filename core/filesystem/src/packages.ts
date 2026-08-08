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
  const importer: (url: string) => Promise<any> =
    typeof (globalThis as any).importShim === "function"
      ? (globalThis as any).importShim.bind(globalThis)
      : (url) => import(/* @vite-ignore */ url);
  try {
    return await importer(entryPointUrl);
  } catch (cause) {
    const retry = new URL(entryPointUrl);
    retry.searchParams.set("retry", "1");
    log(`retrying ${entryPointUrl.slice(-60)}`);
    try {
      return await importer(retry.href);
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
 * Note: an `automerge:` URL is imported as-is, without pinning to heads —
 * callers that need a deterministic version (e.g. {@link ModuleWatcher}) should
 * resolve the handle and pin before importing.
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
  // Only probe http(s) directories for a package.json. A URL that already names
  // a module file, or one on another scheme (e.g. a `data:`/`blob:` module), is
  // imported exactly as given.
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

  // A rejected fetch (a TypeError) is a genuine failure — offline, DNS, or, most
  // commonly here, a cross-origin request blocked because the host sends no
  // `Access-Control-Allow-Origin`. That's distinct from "there's no package.json
  // here" (a non-ok *response*, handled below): don't silently fall back to
  // importing the bare URL, because the same wall blocks the eventual module
  // `import()` too, so the URL is unusable until the host is fixed. Surface it,
  // keeping the original error as `cause`.
  let response: Response;
  try {
    response = await fetch(packageJsonUrl);
  } catch (cause) {
    // Determining the document origin can itself throw off the main thread
    // (no `document`/`location`); guard it so building a helpful error never
    // masks the real `cause`.
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

  // A non-ok response (typically 404) means this URL isn't a package root, so
  // import it directly — a bare directory that serves an `index.js` still works
  // as before.
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
 * Import the entry point of a package (at `folderDocUrl`, which should be
 * pinned to heads) and return the loaded implementation of a single one of the
 * plugins it exports, selected by its `pluginType` and `pluginId`.
 *
 * A plugin `id` is only unique *within* a plugin type (there is a separate
 * registry per type), so a package can export e.g. a `patchwork:datatype` and
 * a `patchwork:tool` that both have id `"x"`. Both `type` and `id` are needed
 * to pick out the right one.
 *
 * This is the main-thread counterpart to discovering a package's plugin
 * descriptors in a worker: the worker reports *which* plugins a package
 * exports, and this re-imports the package here to actually run the plugin's
 * own `load()` / `import` — mirroring what {@link PluginRegistry.load} would do
 * with the live descriptor, so the registered description and the loaded
 * implementation come from the same pinned version.
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
