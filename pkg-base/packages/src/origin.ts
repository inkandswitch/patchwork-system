// Where does a plugin come from? The registry carries no provenance flag — the
// only signal is `importUrl` (the URL of the module the plugin was registered
// from). We compare it against the module lists of the module-settings docs the
// host is watching:
//
//   • the doc you're LOOKING AT (this tool's handle — your account's
//     `moduleSettingsUrl`). If the importUrl's module is listed there, the
//     plugin is "installed" (you added it).
//   • the SYSTEM/default settings doc(s) — the site's built-in tool bundle. If
//     the importUrl's module is listed there (or the importUrl is a plain
//     http(s)/bare, site-served specifier) it's "core".
//   • otherwise, an `automerge:` module that isn't saved in EITHER settings doc
//     was loaded at runtime (a suggested import, a cross-account share) and is
//     "ephemeral" — it vanishes on reload unless you install it.
//
// A module URL is compared by documentId, so a heads-pinned importUrl
// (`automerge:<id>#<heads>`) still matches the bare module URL a settings doc
// stores in `modules[]`. Non-automerge URLs are compared verbatim.

export type Origin = "installed" | "core" | "ephemeral" | "unknown";

export function isAutomergeUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("automerge:");
}

/** An http: or https: URL (by scheme only — it may still fail to parse). */
export function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:/i.test(url);
}

/**
 * Could this be installed as a package? An automerge URL with a plausible
 * documentId, or an http(s) URL that parses.
 */
export function isInstallableUrl(url: string): boolean {
  if (isAutomergeUrl(url)) {
    const id = documentIdOf(url);
    return !!id && id.length >= 16;
  }
  if (isHttpUrl(url)) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The documentId portion of an automerge URL, ignoring any @heads / ?query. */
export function documentIdOf(url: string | undefined): string | undefined {
  if (!isAutomergeUrl(url)) return undefined;
  const rest = url.slice("automerge:".length);
  const match = rest.match(/^[^@?#/]+/);
  return match ? match[0] : undefined;
}

/**
 * A stable identity for a module/importUrl that ignores heads pinning:
 * automerge URLs collapse to their documentId; everything else is itself.
 */
export function moduleKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return documentIdOf(url) ?? url;
}

/** An automerge URL with any #heads/query stripped (`automerge:<id>`); others unchanged. */
export function bareModuleUrl(url: string): string {
  if (!isAutomergeUrl(url)) return url;
  const id = documentIdOf(url);
  return id ? `automerge:${id}` : url;
}

/** The individual head hashes of a heads-pinned automerge URL (`automerge:<id>#h1|h2`). */
export function headsOf(url: string | undefined): string[] {
  if (!isAutomergeUrl(url)) return [];
  const hash = url.indexOf("#");
  if (hash < 0) return [];
  const section = url.slice(hash + 1).replace(/[?].*$/, "");
  return section ? section.split("|") : [];
}

/** Build a heads-pinned automerge URL the way automerge-repo does (sorted, `|`-joined). */
export function pinnedModuleUrl(
  importUrl: string,
  heads: string[]
): string | undefined {
  const id = documentIdOf(importUrl);
  if (!id || heads.length === 0) return undefined;
  return `automerge:${id}#${[...heads].sort().join("|")}`;
}

/** The set of module keys listed in a settings doc's `modules[]`. */
export function moduleKeySet(modules: string[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const m of modules ?? []) {
    const key = moduleKey(m);
    if (key) keys.add(key);
  }
  return keys;
}

export function classifyOrigin(
  importUrl: string | undefined,
  installedKeys: Set<string>,
  systemKeys: Set<string>
): Origin {
  if (!importUrl) return "unknown";
  const key = moduleKey(importUrl)!;
  if (installedKeys.has(key)) return "installed";
  if (systemKeys.has(key)) return "core";
  // A plain http(s)/bare specifier is served by the site itself, never a live
  // automerge doc — treat it as core even if it isn't enumerated in a manifest.
  if (!isAutomergeUrl(importUrl)) return "core";
  // An automerge module in neither settings doc was loaded at runtime.
  return "ephemeral";
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  installed: "my package list",
  core: "system package list",
  ephemeral: "ephemeral",
  unknown: "unknown",
};

/** Longer explanations, shown when a filter is active and as badge tooltips. */
export const ORIGIN_HINT: Record<Origin, string> = {
  installed: "In the package list you're viewing.",
  core: "From the site's default (system) package list.",
  ephemeral:
    "Registered this session but not in any package list — install it to keep it after a reload.",
  unknown: "No import URL, so its origin is unknown.",
};

/** Sort weight: your installs and runtime modules float above the core pile. */
export function originRank(origin: Origin): number {
  switch (origin) {
    case "installed":
      return 0;
    case "ephemeral":
      return 1;
    case "core":
      return 2;
    default:
      return 3;
  }
}
