import type { Plugin, ServerOptions, PreviewOptions, BuildOptions } from "vite";

import { importmap } from "./importmap-plugin.js";
import { serviceworker } from "./service-worker-plugin.js";
import { configPlugin, wasm } from "./config-plugin.js";
import { devPlugin } from "./dev-plugin.js";
import { iconsPlugin } from "./icons.js";
import { htmlPlugin } from "./html-plugin.js";
import { manifestPlugin } from "./manifest-plugin.js";
import { netlifyPlugin } from "./netlify-plugin.js";
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
    configPlugin(options),
    iconsPlugin(options),
    htmlPlugin(options),
    manifestPlugin(options),
    netlifyPlugin(options),
    importmap(options),
    serviceworker(),
    devPlugin(options),
  ].filter((plugin): plugin is Plugin => plugin != null);
}

type Imports = { [name: string]: string };
export type ImportMap = {
  imports: Imports;
  scopes?: { [scope: string]: Imports };
};

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

  server?: false | ServerOptions;
  preview?: false | PreviewOptions;
  worker?: false | { format?: "es" | "iife" };
  build?: BuildOptions;
}
