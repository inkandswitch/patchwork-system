import type { Plugin, ServerOptions, PreviewOptions, BuildOptions } from "vite";

import { importmap } from "./importmap-plugin.js";
import { serviceworker } from "./service-worker-plugin.js";
import { config, wasm } from "./config-plugin.js";
import { dev } from "./dev-plugin.js";
import { icons } from "./icons.js";
import { html } from "./html-plugin.js";
import { manifest } from "./manifest-plugin.js";
import { netlify } from "./netlify-plugin.js";
import { statics, type PatchworkStaticSource } from "./static-plugin.js";
import { buildInfo } from "./build-info-plugin.js";
import type { PatchworkSiteOptions } from "../site-kit/options.js";

/**
 * The patchwork vite plugin. A site's vite.config.ts can shrink down to
 * `plugins: [patchwork({...})]` plus a single source icon file — this plugin
 * owns the wasm plugin, the importmap/service-worker emission, the generated
 * index.html/manifest.webmanifest/Netlify _headers+_redirects, the site's
 * icon set, and vite's server/preview/worker/build/define config.
 *
 * Each generated piece is switched off individually by passing `false` for
 * its option (`html: false`, `manifest: false`, `netlify: false`,
 * `icons: false`, `server: false`, `preview: false`, `worker: false`).
 *
 * `server`/`preview`/`worker`/`build`/`define` are owned by this plugin's
 * `config()` hook and driven entirely by these options — don't also set them
 * in the site's own `defineConfig({...})` alongside `patchwork()`, since
 * Vite's plugin-config merge order doesn't guarantee which one wins.
 *
 * Most of what this plugin does — icon rendering, and building the
 * index.html/manifest.webmanifest/Netlify _headers content — has no vite
 * dependency at all; see `../site-kit/index.ts` for those pieces reused by
 * a different bundler adapter.
 */
export default function patchwork(options?: PatchworkVitePluginOptions) {
  return [
    wasm(),
    config(options),
    icons(options),
    html(options),
    manifest(options),
    netlify(options),
    importmap(options),
    serviceworker(),
    dev(options),
    statics(options),
    buildInfo(options),
  ].filter((plugin): plugin is Plugin => plugin != null);
}

export { importmap, builtins, devDependencyId } from "./importmap-plugin.js";
export { serviceworker, workers } from "./service-worker-plugin.js";
export { config, buildDefines, wasm } from "./config-plugin.js";
export { dev } from "./dev-plugin.js";
export { icons } from "./icons.js";
export { html } from "./html-plugin.js";
export { manifest } from "./manifest-plugin.js";
export { netlify } from "./netlify-plugin.js";
export { statics, resolveStatic } from "./static-plugin.js";
export { buildInfo } from "./build-info-plugin.js";

type Imports = { [name: string]: string };
export type ImportMap = {
  imports: Imports;
  scopes?: { [scope: string]: Imports };
};

export type { PatchworkStaticSource } from "./static-plugin.js";

export type {
  PatchworkSiteOptions,
  PatchworkIconsOptions,
  PatchworkHtmlOptions,
  PatchworkNetlifyOptions,
  PatchworkKeyhiveSyncServer,
  PatchworkSyncServersOptions,
} from "../site-kit/options.js";

export interface PatchworkVitePluginOptions extends PatchworkSiteOptions {
  importmap?: ImportMap;

  /**
   * File trees to mount into the site, in order of precedence — a package of
   * Patchwork modules, a sibling repo's build output, a hand-written
   * modules.json. Served in dev, copied into the site at build, and never
   * overwriting the site's own files. A bare string is `{from: string}`.
   */
  static?: (string | PatchworkStaticSource)[];
  /**
   * Write build-info.json: this site's revision, the patchwork version that
   * built it, and every `static` source. An object is merged into it, for
   * whatever else the site wants recorded.
   */
  buildInfo?: boolean | Record<string, unknown>;

  server?: false | ServerOptions;
  preview?: false | PreviewOptions;
  worker?: false | { format?: "es" | "iife" };
  build?: BuildOptions;
}
