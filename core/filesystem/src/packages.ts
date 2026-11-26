import {
  type AutomergeUrl,
  isValidAutomergeUrl,
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
export async function importModule(entryPointUrl: string): Promise<any> {
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
  conditions: string[] = defaultImportConditions,
  importer: (url: string) => Promise<any> = importModule,
) {
  log(`importPackage ${folderDocUrl}... (subpath: ${subpath})`);
  return importFromPackage(
    await locateFolderDocPackage(folderDocUrl),
    subpath,
    conditions,
    importer,
  );
}

export async function importPackageFromHttpUrl(
  url: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions,
  importer: (url: string) => Promise<any> = importModule,
) {
  return importFromPackage(
    await locateHttpPackage(url),
    subpath,
    conditions,
    importer,
  );
}

/**
 * An `automerge:` URL is imported as given, not pinned to heads: pin it first
 * if the version matters, as {@link ModuleWatcher} does.
 */
export async function importPackage(
  url: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions,
  importer: (url: string) => Promise<any> = importModule,
) {
  return isValidAutomergeUrl(url)
    ? importPackageFromFolderDocUrl(url, subpath, conditions, importer)
    : importPackageFromHttpUrl(url, subpath, conditions, importer);
}

/** A `package.json` as read from `importUrl`, at `version`. */
export type PackageJsonAt = {
  importUrl: string;
  /** The package root, ending in `/`: what `exports` resolve against. */
  base: string;
  packageJson: Record<string, any>;
  /** An automerge url's heads, or the SHA-256 of an http `package.json`. */
  version: string;
};

/** `plugins` is undefined when the entry point exports no `plugins` array. */
export type ImportedPackage = { plugins?: any[]; package?: PackageJsonAt };

async function locate(url: string): Promise<PackageLocation> {
  return isValidAutomergeUrl(url)
    ? locateFolderDocPackage(url)
    : locateHttpPackage(url);
}

function packageAt(
  importUrl: string,
  location: PackageLocation,
): PackageJsonAt | undefined {
  if (location.kind !== "package") return undefined;
  const { base, pkgJson: packageJson, version } = location;
  return { importUrl, base, packageJson, version };
}

/** The `package.json` at `url`, or `undefined` for a module url. */
export async function readPackageJson(
  url: string,
): Promise<PackageJsonAt | undefined> {
  return packageAt(url, await locate(url));
}

/**
 * Like {@link importPackage} for the package's main entry, but also hands back
 * the `package.json` it read (fetched once), if there was one.
 */
export async function importPackageWithJson(
  url: string,
): Promise<ImportedPackage> {
  const location = await locate(url);
  const mod = await importFromPackage(
    location,
    ".",
    defaultImportConditions,
    importModule,
  );
  return {
    plugins: Array.isArray(mod?.plugins) ? mod.plugins : undefined,
    package: packageAt(url, location),
  };
}

/**
 * The plugins a package lists in its `package.json` under `patchwork.plugins`
 * (see {@link pluginsFromManifest}), read without importing any of its code;
 * `undefined` if it has no such list, or isn't a package root.
 *
 * Reading a manifest runs nothing, so it's safe on the main thread: the
 * bootloader asks this first and only sends a package to its worker when it
 * has to import the entry point to find out what's in it.
 */
export async function readPluginManifest(
  url: string,
  conditions: string[] = defaultImportConditions,
): Promise<{ plugins: Array<Record<string, any>> } | undefined> {
  const pkg = await readPackageJson(url);
  if (!pkg || !hasPluginManifest(pkg.packageJson)) return undefined;
  return {
    plugins: pluginsFromManifest(pkg.packageJson, pkg.base, conditions),
  };
}

// Module file extensions that mark a URL as a direct entry point rather than a
// package/site root to look for a `package.json` in.
const MODULE_FILE_EXTENSION = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;

/**
 * Where a package's code is: a module to import as it is, or a package root
 * (`base`, ending in `/`) with the `package.json` read from it.
 */
type PackageLocation =
  | { kind: "module"; href: string }
  | {
    kind: "package";
    base: string;
    pkgJson: Record<string, any>;
    version: string;
  };

async function locateHttpPackage(url: string): Promise<PackageLocation> {
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
  const isHttp = resolved.protocol === "http:" ||
    resolved.protocol === "https:";
  if (!isHttp || MODULE_FILE_EXTENSION.test(resolved.pathname)) {
    return { kind: "module", href: resolved.href };
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
      { cause },
    );
  }

  // Not a package root (usually a 404), so import it directly: a directory
  // that serves an `index.js` works.
  if (!response.ok) {
    log(
      `no package.json at ${packageJsonUrl} (HTTP ${response.status}); importing ${resolved.href} directly`,
    );
    return { kind: "module", href: resolved.href };
  }

  const text = await response.text();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const version = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")).join("");
  let pkgJson: Record<string, any>;
  try {
    pkgJson = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Fetched ${packageJsonUrl} but couldn't parse it as JSON`, {
      cause,
    });
  }

  return { kind: "package", base, pkgJson, version };
}

async function locateFolderDocPackage(
  folderDocUrl: AutomergeUrl,
): Promise<PackageLocation> {
  const base = new URL(
    getImportableUrlFromAutomergeUrl(folderDocUrl),
    documentBaseOrigin(),
  ).href;
  const pkgJson = await packageJsonContentsFromFolderDocUrl(folderDocUrl);
  const version = folderDocUrl.split("#")[1] ?? "";
  return { kind: "package", base, pkgJson, version };
}

async function importFromPackage(
  location: PackageLocation,
  subpath: string,
  conditions: string[],
  importer: (url: string) => Promise<any>,
) {
  if (location.kind === "module") {
    log(`importing ${location.href.slice(-60)}`);
    return importer(location.href);
  }
  const { base, pkgJson } = location;
  // A package that lists its plugins in package.json says what they are
  // without running any of its code: its entry point isn't imported, and each
  // plugin's `load()` imports only its own export.
  if (subpath === "." && hasPluginManifest(pkgJson)) {
    log(`reading plugins from package.json at ${base.slice(-60)}`);
    return { plugins: pluginsFromManifest(pkgJson, base, conditions) };
  }
  const entryPointUrl = new URL(
    resolvePackageExport(pkgJson, subpath, conditions),
    base,
  ).href;
  log(`importing ${entryPointUrl.slice(-60)}`);
  return importer(entryPointUrl);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `package.json` lists its plugins under `patchwork.plugins`. */
export function hasPluginManifest(pkgJson: Record<string, any>): boolean {
  return isRecord(pkgJson?.patchwork?.plugins);
}

/**
 * The plugins a `package.json` lists under `patchwork.plugins`, keyed by type
 * and then id:
 *
 * ```json
 * "patchwork": {
 *   "plugins": {
 *     "patchwork:tool": {
 *       "some-id": { "name": "…", "export": "./tools/whatever" }
 *     }
 *   }
 * }
 * ```
 *
 * Each entry's other fields are its description. Its `export` is resolved
 * through the package's `exports` with `conditions` up front. `load()` imports
 * it and returns its default export, or the whole module if it has none. An
 * entry with no `export` loads nothing.
 *
 * An `export` that matches nothing breaks only that plugin: it's still listed,
 * a warning says why, and its `load()` rejects. The package's other plugins
 * are unaffected.
 *
 * A relative `style` (a theme's stylesheet) is a file in the package, so it's
 * resolved against `base` here: whoever reads the description gets a URL
 * that works from any page.
 */
export function pluginsFromManifest(
  pkgJson: Record<string, any>,
  base: string,
  conditions: string[] = defaultImportConditions,
): Array<Record<string, any>> {
  const byType = pkgJson?.patchwork?.plugins;
  if (!isRecord(byType)) return [];
  const plugins: Array<Record<string, any>> = [];
  for (const [type, byId] of Object.entries(byType)) {
    if (!isRecord(byId)) continue;
    for (const [id, entry] of Object.entries(byId)) {
      if (!isRecord(entry)) continue;
      const { export: subpath, ...description } = entry;
      if (typeof description.style === "string") {
        description.style = new URL(description.style, base).href;
      }
      let load = async () => {};
      if (subpath !== undefined) {
        let entryPoint: string;
        try {
          if (typeof subpath !== "string") throw new Error("not a string");
          entryPoint = resolvePackageExport(pkgJson, subpath, conditions);
        } catch {
          const error = new Error(
            `Plugin "${type}:${id}" in ${base}package.json has "export" ${
              JSON.stringify(subpath)
            }, which matches nothing in its "exports"`,
          );
          console.warn(error.message);
          plugins.push({
            ...description,
            type,
            id,
            load: () => Promise.reject(error),
          });
          continue;
        }
        load = async () => {
          const url = new URL(entryPoint, base).href;
          log(`importing ${type}:${id} from ${url.slice(-60)}`);
          const mod = await importModule(url);
          // todo this may be a bad idea
          return "default" in mod ? mod.default : mod;
        };
      }
      plugins.push({
        ...description,
        type,
        id,
        load,
      });
    }
  }
  return plugins;
}

/**
 * Import the entry point of a package (at `packageUrl`: a folder doc pinned to
 * heads, or an http url) and return the loaded implementation of one plugin it
 * exports, picked by `pluginType` and `pluginId`: an id is only unique within a
 * type.
 *
 * The main-thread half of discovering plugins in a worker: the worker says
 * which plugins a package exports, and this runs one's own `load()` or
 * `import`, so its description and implementation come from the same version.
 */
export async function importPluginFromPackage(
  packageUrl: string,
  pluginType: string,
  pluginId: string,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions,
  importer: (url: string) => Promise<any> = importModule,
) {
  const mod = await importPackage(packageUrl, subpath, conditions, importer);
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const plugin = plugins.find(
    (p) => p?.type === pluginType && p?.id === pluginId,
  );
  if (!plugin) {
    throw new Error(
      `No plugin "${pluginType}:${pluginId}" exported by the package at ${packageUrl}`,
    );
  }
  if (typeof plugin.load === "function") {
    return plugin.load();
  }
  if (typeof plugin.import === "string") {
    return importer(plugin.import);
  }
  throw new Error(
    `Plugin "${pluginType}:${pluginId}" at ${packageUrl} has no load() function or import URL`,
  );
}

/** @deprecated Use {@link importPluginFromPackage}, which also takes an http url. */
export const importPluginFromFolderDocUrl: (
  folderDocUrl: AutomergeUrl,
  pluginType: string,
  pluginId: string,
  subpath?: string,
  conditions?: string[],
) => Promise<any> = importPluginFromPackage;

async function packageJsonContentsFromFolderDocUrl(
  folderDocUrl: AutomergeUrl,
): Promise<Record<string, any>> {
  const packageJSONPath = new URL(
    "package.json",
    new URL(
      getImportableUrlFromAutomergeUrl(folderDocUrl),
      documentBaseOrigin(),
    ),
  ).href;

  log(`fetching ${packageJSONPath.slice(-60)}`);

  let response: Response;
  try {
    response = await fetch(packageJSONPath);
  } catch (cause) {
    throw new Error(
      `Couldn't fetch ${packageJSONPath} for ${folderDocUrl} — a network error, or the service worker isn't serving automerge module URLs`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${packageJSONPath} for ${folderDocUrl}: HTTP ${response.status}`,
    );
  }
  log(`package.json OK for ${folderDocUrl.slice(0, 25)}...`);
  return response.json();
}

export function resolvePackageExport(
  pkgJson: Record<string, any>,
  subpath: string = ".",
  conditions: string[] = defaultImportConditions,
): string {
  try {
    const resolved = resolve(pkgJson, subpath, { conditions });
    if (resolved) return resolved[0];
  } catch {}

  if (subpath === "." && typeof pkgJson.main === "string") {
    return pkgJson.main;
  }

  throw new Error(
    `No valid 'exports' for "${subpath}" or 'main' in package.json`,
  );
}
