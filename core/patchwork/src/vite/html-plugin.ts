import type { Plugin } from "vite";
import { resolve } from "node:path";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildHtml } from "../site-kit/html.js";

const GENERATED_PATH = "index.html";

/**
 * Vite's html build step (`vite:build-html`) is a normal `transform` hook
 * filtered on `id: /\.html$/` — it doesn't require a real file, just an id
 * that *looks like* one under root (that's all `path.relative(root, id)`,
 * which decides the output filename, cares about). So this is a plain
 * virtual module: `resolveId` claims the one id we care about, `load`
 * returns the generated string — nothing ever touches disk.
 */
export function html(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (options.html === false) return null;

  const html = buildHtml(options);
  let entryId: string;

  return {
    name: "@patchwork/html",
    enforce: "pre",
    config(config) {
      const root = resolve(config.root ?? process.cwd());
      entryId = resolve(root, GENERATED_PATH);
      return {
        build: { rollupOptions: { input: entryId } },
      };
    },
    resolveId(source) {
      if (source === entryId) return entryId;
    },
    load(id) {
      if (id === entryId) return html;
    },
    configureServer: {
      order: "pre",
      handler(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/" && req.url !== "/index.html") {
            next();
            return;
          }
          const transformed = await server.transformIndexHtml(
            req.url,
            html,
            req.originalUrl
          );
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(transformed);
        });
      },
    },
  };
}
