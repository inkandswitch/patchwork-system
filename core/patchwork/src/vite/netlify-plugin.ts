import type { Plugin, ResolvedConfig } from "vite";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildHeaders, buildRedirects } from "../site-kit/netlify.js";
import { hashedFiles } from "./hashed-plugin.js";

/**
 * Netlify's _headers and _redirects, for the production build only: they mean
 * nothing anywhere else. The Link header takes its sync-server and wasm lists
 * from the same place html-plugin does, so the two agree. Both files name the
 * hashed files, so they're written once those names are known.
 */
export function netlify(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (options.netlify === false) return null;

  let config: ResolvedConfig;

  return {
    name: "@patchwork/netlify",
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle() {
      if (config.command !== "build") return;
      const { urls } = hashedFiles(config);
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: buildHeaders(options, urls),
      });
      this.emitFile({
        type: "asset",
        fileName: "_redirects",
        source: buildRedirects(urls),
      });
    },
  };
}
