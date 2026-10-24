import type { Plugin, ResolvedConfig } from "vite";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildHeaders, buildRedirects } from "../site-kit/netlify.js";
import { hashedFiles } from "./hashed-plugin.js";

/**
 * Netlify's _headers/_redirects are only meaningful on an actual Netlify
 * deploy, so this only runs for the production build — no dev middleware.
 * The Link header shares its sync-server/wasm-asset lists with html-plugin
 * so the two never drift out of sync with each other. Both are written once
 * the hashed file names are known, which they name.
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
