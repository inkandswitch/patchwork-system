import type { Plugin } from "vite";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildManifest } from "../site-kit/manifest.js";

/** Emits manifest.webmanifest for build and serves it for dev, from the same generated object. */
export function manifest(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (options.manifest === false) return null;

  const manifest = buildManifest(options);
  const source = JSON.stringify(manifest, null, 2);
  let isBuild = false;

  return {
    name: "@patchwork/manifest",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    buildStart() {
      if (!isBuild) return;
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source,
      });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/manifest.webmanifest") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(source);
      });
    },
  };
}
