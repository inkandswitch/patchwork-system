import type { Plugin } from "vite";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildHeaders, REDIRECTS } from "../site-kit/netlify.js";

/**
 * Netlify's _headers/_redirects are only meaningful on an actual Netlify
 * deploy, so this only runs for the production build — no dev middleware.
 * The Link header shares its sync-server/wasm-asset lists with html-plugin
 * so the two never drift out of sync with each other.
 */
export function netlify(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (options.netlify === false) return null;

  const headers = buildHeaders(options);
  let isBuild = false;

  return {
    name: "@patchwork/netlify",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    buildStart() {
      if (!isBuild) return;
      this.emitFile({ type: "asset", fileName: "_headers", source: headers });
      this.emitFile({
        type: "asset",
        fileName: "_redirects",
        source: REDIRECTS,
      });
    },
  };
}
