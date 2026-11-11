import type { ArkVersion } from "@inkandswitch/patchwork-bootloader";
// Options for a site's generated files (icons, index.html, the manifest,
// Netlify config), with nothing vite-specific in them, so another bundler can
// use them too. `../vite/patchwork-plugin.ts` adds the vite parts.

export interface PatchworkIconsOptions {
  /** Path (relative to the site root) to a source svg or raster image. Every icon size is rendered from it via sharp. */
  source: string;
  /** Path to a monochrome svg for Safari's pinned-tab mask icon. Omitted entirely if not set. */
  maskIcon?: string;
  maskIconColor?: string;
}

export interface PatchworkHtmlOptions {
  lang?: string;
  /** Raw HTML appended after the generated head — e.g. extra <link>/<meta> tags. */
  extraHead?: string;
  /** Raw HTML appended after the app root and entry script. */
  extraBody?: string;
  /**
   * Attributes set on the root `<html>` element. How a site states its own
   * configuration to the packages it loads: a package reads the attribute
   * instead of guessing from load order. `lang` stays its own option.
   */
  attributes?: Record<string, string>;
}

export interface PatchworkNetlifyOptions {
  /** Cache-Control: immutable on /assets/*. Default true. */
  immutableAssets?: boolean;
}

/** @deprecated Patchwork no longer uses keyhive. */
export interface PatchworkKeyhiveOptions {
  /** @deprecated Ignored. */
  ark?: ArkVersion;
}

export type PatchworkSyncServersOptions = {
  /** wss:// URL for the legacy automerge-repo sync-server channel (only for its preconnect hint: automerge-repo 3 has no classic sync). Default: wss://sync3.automerge.org. Pass false to skip its preconnect hint. */
  classic?: string | false;
  /** wss:// URL for the subduction channel. Default: wss://subduction.sync.inkandswitch.com. */
  subduction?: string;
};

export const DEFAULT_TITLE = "Patchwork";

export interface PatchworkSiteOptions {
  /**
   * Namespace for this site's IndexedDB databases and peer ids
   * (-> __STORAGE_PREFIX__ define). Defaults to `"patchwork"`. Sites sharing
   * an origin MUST use distinct prefixes.
   *
   * The tab and the shared automerge worker are separate bundles that have to
   * open the same databases, so this is settable only here, where both of them
   * receive it. Changing it on an existing site points it at empty storage.
   */
  storagePrefix?: string;
  /**
   * This site's name: `<title>`, apple-mobile-web-app-title, manifest name,
   * and — via the __SITE_TITLE__ define — the brand word the router appends to
   * the document title as `"<doc> | <title>"`. Defaults to `"Patchwork"`.
   */
  title?: string;
  /** manifest short_name (defaults to title) */
  shortName?: string;
  /** manifest description, <meta name=description> */
  description?: string;
  /** default "/src/main.ts" — must be root-absolute, since the generated index.html doesn't live at the project root */
  entry?: string;

  themeColor?: string | { light: string; dark: string };
  /** manifest background_color */
  backgroundColor?: string;

  /** @deprecated Patchwork no longer uses keyhive: ignored. */
  keyhive?: boolean | PatchworkKeyhiveOptions;

  /**
   * The sync-server URLs for this build. Also emitted as connection hints;
   * pass `false` to keep the URLs but skip the hints.
   */
  syncServers?: false | PatchworkSyncServersOptions;

  icons?: false | PatchworkIconsOptions;
  html?: false | PatchworkHtmlOptions;
  manifest?: false | Record<string, unknown>;
  netlify?: false | PatchworkNetlifyOptions;
}
