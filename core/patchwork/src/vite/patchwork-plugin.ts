import type { Plugin, ServerOptions, PreviewOptions, BuildOptions } from "vite";

import { importmap } from "./importmap-plugin.js";
import { patches } from "./patches-plugin.js";
import {
  preloadErrorInWorkers,
  serviceworker,
} from "./service-worker-plugin.js";
import { config, wasm } from "./config-plugin.js";
import { dev } from "./dev-plugin.js";
import { icons } from "./icons.js";
import { html } from "./html-plugin.js";
import { manifest } from "./manifest-plugin.js";
import { netlify } from "./netlify-plugin.js";
import { hashed } from "./hashed-plugin.js";
import { statics, type PatchworkStaticSource } from "./static-plugin.js";
import { buildInfo } from "./build-info-plugin.js";
import type { PatchworkSiteOptions } from "../site-kit/options.js";

/**
 * The patchwork vite plugin: a site's vite.config.ts can be
 * `plugins: [patchwork({...})]` and one icon file. It brings the wasm plugin,
 * the import map and service worker, the generated index.html, manifest,
 * Netlify _headers and _redirects, the icons, and vite's
 * server/preview/worker/build/define config. Pass `false` for `html`,
 * `manifest`, `netlify`, `icons`, `server`, `preview` or `worker` to leave
 * that piece out.
 *
 * Don't also set `server`, `preview`, `worker`, `build` or `define` in the
 * site's own `defineConfig`: vite doesn't promise which one wins.
 *
 * The parts with no vite in them are in `../site-kit/index.ts`.
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
    patches(),
    serviceworker(),
    preloadErrorInWorkers(),
    hashed(),
    dev(options),
    statics(options),
    buildInfo(options),
  ].filter((plugin): plugin is Plugin => plugin != null);
}

export { importmap, builtins, devDependencyId } from "./importmap-plugin.js";
export { patches } from "./patches-plugin.js";
export {
  preloadErrorInWorkers,
  serviceworker,
  workers,
} from "./service-worker-plugin.js";
export { config, buildDefines, wasm } from "./config-plugin.js";
export { dev } from "./dev-plugin.js";
export { icons } from "./icons.js";
export { html } from "./html-plugin.js";
export { manifest } from "./manifest-plugin.js";
export { netlify } from "./netlify-plugin.js";
export { hashed, hashedFiles, HashedFiles } from "./hashed-plugin.js";
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
  /**
   * This build's id (-> __BUILD_ID__ define), a number where later builds
   * compare greater. Defaults to `Date.now()` when the build starts. A tab
   * from a newer build connecting to the shared automerge worker makes it
   * restart on the new code, and tabs on older builds offer to reload. Set it from a
   * CI run number to make it deterministic; keep it increasing, since a
   * build with a lower id than the one running is left alone (so to roll
   * back, rebuild rather than republish an old build).
   */
  buildId?: number;

  server?: false | ServerOptions;
  preview?: false | PreviewOptions;
  worker?: false | { format?: "es" | "iife" };
  build?: BuildOptions;
}
