import type { ArkVersion } from "@inkandswitch/patchwork-bootloader/keyhive-sync-server";

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

export interface PatchworkKeyhiveOptions {
  /**
   * The automerge-repo-keyhive to build with, which has to be the one the
   * sync server runs. `"0.8"` is the current stack. `"0.6"` is the previous
   * one, which patchwork installs under `@ark-0.6/*`: ARK 0.6, keyhive 0.3,
   * and the automerge-repo and subduction they were built with, swapped in
   * whole.
   * It only knows subduction.sync.inkandswitch.com's identity.
   *
   * Defaults to `"0.6"` when `syncServers.subduction` is on
   * subduction.sync.inkandswitch.com, which hasn't moved to 0.8 yet, and
   * `"0.8"` anywhere else. Each keeps its keyhive state in its own database.
   */
  ark?: ArkVersion;
  /**
   * Use the `idFactory` ARK injects into the repo config, which derives
   * document ids from keyhive. Default true. `false` drops it and lets the
   * Repo generate ids its own way.
   */
  useIdFactory?: boolean;
}

export type PatchworkSyncServersOptions = {
  /** wss:// URL for the legacy automerge-repo sync-server channel (connected on demand via connectClassicSync). Default: wss://sync3.automerge.org. Pass false to skip its preconnect hint. */
  classic?: string | false;
  /** wss:// URL for the subduction channel. Default: wss://subduction.sync.inkandswitch.com. A keyhive build uses it too, and fetches the server's contact card from `/keyhive/contact-card` on the same host. */
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

  /**
   * Enables keyhive for this build, against the `syncServers.subduction`
   * server. `true` takes every default; an object turns individual behaviour
   * off. Omitted or `false` builds a plain subduction repo.
   */
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
