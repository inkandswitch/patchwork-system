// The parts of building a site's files with no bundler in them: icons, and the
// index.html, manifest and Netlify _headers builders, for any bundler.
// `../vite/*` wires them into vite.
export type {
  PatchworkSiteOptions,
  PatchworkIconsOptions,
  PatchworkHtmlOptions,
  PatchworkNetlifyOptions,
  PatchworkSyncServersOptions,
} from "./options.js";

export { resolveSyncServers, PRELOAD_WASM_ASSETS } from "./sync-servers.js";
export { getIcons, ICON_SPECS, type IconSpec } from "./icons.js";
export { buildHtml, escapeHtml } from "./html.js";
export { buildManifest } from "./manifest.js";
export {
  buildHeaders,
  buildRedirects,
  REDIRECTS,
  REVALIDATED_PATHS,
  REVALIDATED_CACHE_CONTROL,
} from "./netlify.js";
