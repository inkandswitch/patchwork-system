/**
 * The bundler-agnostic parts of building a Patchwork site's static assets —
 * icon rendering, and the index.html/manifest.webmanifest/Netlify _headers
 * content builders. No `vite` import anywhere in this directory: a
 * different bundler adapter (esbuild, webpack, or a plain pre-build script)
 * can reuse these directly. `../vite/*` is the vite-specific adapter that
 * wires these into vite's plugin hooks (dev middleware, emitFile, virtual
 * modules, config()).
 */
export type {
  PatchworkSiteOptions,
  PatchworkIconsOptions,
  PatchworkHtmlOptions,
  PatchworkNetlifyOptions,
  PatchworkKeyhiveSyncServer,
  PatchworkKeyhiveOptions,
  PatchworkSyncServersOptions,
} from "./options.js";

export { resolveSyncServers, PRELOAD_WASM_ASSETS } from "./sync-servers.js";
export { getIcons, ICON_SPECS, type IconSpec } from "./icons.js";
export { buildHtml, escapeHtml } from "./html.js";
export { buildManifest } from "./manifest.js";
export { buildHeaders, REDIRECTS } from "./netlify.js";
