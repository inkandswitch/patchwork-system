import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  defaultImportConditions,
  documentBaseOrigin,
  getImportableUrlFromAutomergeUrl,
  resolvePackageExport,
} from "@inkandswitch/patchwork-filesystem";
import debug from "debug";
import type {
  PackageManifest,
  PatchworkPackage,
  PluginManifest,
} from "./types.js";

const log = debug("patchwork:packages");

export const MANIFEST_FILENAME = "patchwork.json";

export function packageBaseUrl(url: string): string {
  if (isValidAutomergeUrl(url)) return getImportableUrlFromAutomergeUrl(url);
  let resolved: URL;
  try {
    resolved = new URL(url);
  } catch {
    resolved = new URL(url, documentBaseOrigin());
  }
  return resolved.href.endsWith("/") ? resolved.href : `${resolved.href}/`;
}

async function fetchJson(
  url: string
): Promise<Record<string, any> | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(`Couldn't fetch ${url}`, { cause });
  }
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new Error(`Fetched ${url} but couldn't parse it as JSON`, { cause });
  }
}

function validate(manifest: unknown, url: string): PackageManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${url} is not an object`);
  }
  const { manifest: version, plugins } = manifest as PackageManifest;
  if (version !== 1) {
    throw new Error(`${url} has unsupported manifest version ${version}`);
  }
  if (!Array.isArray(plugins)) {
    throw new Error(`${url} has no plugins array`);
  }
  for (const plugin of plugins) {
    for (const field of ["id", "type", "import"] as const) {
      if (typeof plugin?.[field] !== "string") {
        throw new Error(`${url} has a plugin with no ${field}`);
      }
    }
  }
  return manifest as PackageManifest;
}

/**
 * A plugin's `import` is first offered to package.json `exports` as a subpath,
 * so `"import": "./tool"` can be aimed at a `patchwork` condition. Anything
 * `exports` doesn't answer for is a path or URL relative to the package root.
 */
function resolveImport(
  spec: string,
  base: string,
  packageJson: Record<string, any> | undefined,
  conditions: string[]
): string {
  if (packageJson) {
    try {
      return new URL(resolvePackageExport(packageJson, spec, conditions), base)
        .href;
    } catch {}
  }
  return new URL(spec, base).href;
}

export async function readPackageManifest(
  url: string,
  conditions: string[] = defaultImportConditions
): Promise<PatchworkPackage | undefined> {
  const base = packageBaseUrl(url);
  const manifestUrl = new URL(MANIFEST_FILENAME, base).href;
  log(`fetching ${manifestUrl.slice(-60)}`);
  const raw = await fetchJson(manifestUrl);
  if (raw === undefined) return undefined;

  const manifest = validate(raw, manifestUrl);
  const packageJson = manifest.plugins.length
    ? await fetchJson(new URL("package.json", base).href).catch(() => undefined)
    : undefined;

  const plugins: PluginManifest[] = manifest.plugins.map((plugin) => ({
    ...plugin,
    import: resolveImport(plugin.import, base, packageJson, conditions),
  }));

  return {
    url,
    base,
    name: manifest.name,
    permissions: manifest.permissions ?? [],
    plugins,
  };
}
