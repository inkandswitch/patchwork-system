import type { Plugin } from "vite";
import { resolve } from "node:path";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { getIcons } from "../site-kit/icons.js";

/** Emits the rendered icon PNGs for build, and serves the same buffers for dev. */
export function icons(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (!options.icons) return null;
  const { source } = options.icons;

  let sourcePath: string;
  let isBuild = false;

  return {
    name: "@patchwork/icons",
    configResolved(config) {
      isBuild = config.command === "build";
      sourcePath = resolve(config.root, source);
    },
    async buildStart() {
      if (!isBuild) return;
      const icons = await getIcons(sourcePath);
      for (const [fileName, buffer] of icons) {
        this.emitFile({ type: "asset", fileName, source: buffer });
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const fileName = req.url?.replace(/^\//, "");
        if (!fileName) {
          next();
          return;
        }
        const icons = await getIcons(sourcePath);
        const buffer = icons.get(fileName);
        if (!buffer) {
          next();
          return;
        }
        res.setHeader("Content-Type", "image/png");
        res.end(buffer);
      });
    },
  };
}
