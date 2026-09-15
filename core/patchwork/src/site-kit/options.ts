import type { SyncServerIdentity } from "@automerge/automerge-repo-keyhive";

/**
 * The bundler-agnostic option shape for a Patchwork site's generated
 * static assets (icons, index.html, manifest.webmanifest, Netlify config).
 * `../vite/patchwork-plugin.ts` extends this with vite-only config
 * (importmap, server/preview/worker/build) — a different bundler adapter
 * can reuse this same shape and the pure builders in this directory without
 * pulling in anything vite-specific.
 */

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

export type PatchworkKeyhiveSyncServer =
  | "keyhive"
  | "subduction"
  | ({ url: string } & SyncServerIdentity);

export interface PatchworkKeyhiveOptions {
  /**
   * Which relay ARK registers and grants access to. Default `"subduction"`.
   * A custom identity also carries the WebSocket URL to reach it on.
   */
  syncServer?: PatchworkKeyhiveSyncServer;
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
  /** wss:// URL for the subduction channel. Default: wss://subduction.sync.inkandswitch.com. Overrides the URL a named `keyhive.syncServer` would otherwise imply. */
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
   * Enables keyhive for this build. `true` takes every default; an object
   * picks the relay and turns individual behaviour off. Omitted or `false`
   * builds a plain subduction repo.
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
