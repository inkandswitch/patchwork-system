import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { wasmAssets } from "@inkandswitch/patchwork-bootloader/externals";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { buildDefines } from "./config-plugin.js";
import { builtins, devDependencyId } from "./importmap-plugin.js";
import { workers } from "./service-worker-plugin.js";

const PATCHWORK_CSS = "/@inkandswitch/patchwork/global.css";
const BOOTLOADER_CSS = "/@inkandswitch/patchwork-bootloader/global.css";

// The generated index.html links the stylesheet by bare specifier, which the
// build resolves and the dev server does not. Serving the two files under
// these paths, and pointing the link at the first one, covers the gap.
const stylesheets: Record<string, string> = {
  [PATCHWORK_CSS]: fileURLToPath(
    import.meta.resolve("@inkandswitch/patchwork/global.css")
  ),
  [BOOTLOADER_CSS]: fileURLToPath(
    import.meta.resolve("@inkandswitch/patchwork-bootloader/global.css")
  ),
};

/**
 * Workers are `type: "module"` scripts the browser fetches directly, so import
 * maps don't apply to them and their heavy imports have to resolve to real
 * URLs. The build rewrites those to the `/packages/...` chunks it emits; here
 * they become the dev server's own optimized-dep URLs.
 */
function externalBuiltins(): esbuild.Plugin {
  return {
    name: "patchwork-dev-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!(args.path in builtins)) return null;
        return {
          path: `/@id/${devDependencyId(args.path)}`,
          external: true,
        };
      });
    },
  };
}

function workerContexts(
  options: PatchworkVitePluginOptions
): Map<string, Promise<esbuild.BuildContext>> {
  const contexts = new Map<string, Promise<esbuild.BuildContext>>();
  for (const { specifier, fileName } of workers) {
    contexts.set(
      `/${fileName}`,
      esbuild.context({
        entryPoints: [fileURLToPath(import.meta.resolve(specifier))],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "firefox115",
        sourcemap: "inline",
        define: buildDefines(options),
        plugins: [externalBuiltins()],
      })
    );
  }
  return contexts;
}

export function devPlugin(options: PatchworkVitePluginOptions = {}): Plugin {
  let serve = false;
  let contexts: Map<string, Promise<esbuild.BuildContext>> | undefined;
  const wasm = new Map(
    wasmAssets().map(({ fileName, path }) => [`/${fileName}`, path])
  );

  return {
    name: "@patchwork/dev",
    configResolved(config) {
      serve = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (!serve) return html;
      return html.replace(
        `href="@inkandswitch/patchwork/global.css"`,
        `href="${PATCHWORK_CSS}"`
      );
    },
    async buildEnd() {
      if (!contexts) return;
      for (const context of contexts.values()) (await context).dispose();
      contexts = undefined;
    },
    configureServer(server) {
      contexts = workerContexts(options);

      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?")[0] ?? "";

        const stylesheet = stylesheets[pathname];
        if (stylesheet) {
          try {
            const css = await readFile(stylesheet, "utf8");
            response.setHeader("Content-Type", "text/css");
            response.setHeader("Cache-Control", "no-cache");
            response.end(
              pathname === PATCHWORK_CSS
                ? css.replace(
                    `"@inkandswitch/patchwork-bootloader/global.css"`,
                    `"${BOOTLOADER_CSS}"`
                  )
                : css
            );
          } catch {
            next();
          }
          return;
        }

        const binary = wasm.get(pathname);
        if (binary) {
          try {
            response.setHeader("Content-Type", "application/wasm");
            response.setHeader("Cache-Control", "no-cache");
            response.end(await readFile(binary));
          } catch {
            next();
          }
          return;
        }

        const context = contexts?.get(pathname);
        if (!context) return next();
        try {
          // Rebuilt per request rather than watched: a worker is fetched once
          // when the browser starts it, and esbuild's incremental rebuild is
          // cheaper than keeping a watcher per entry.
          const result = await (await context).rebuild();
          response.setHeader("Content-Type", "text/javascript");
          response.setHeader("Cache-Control", "no-cache");
          response.end(result.outputFiles![0]!.text);
        } catch (error) {
          // A worker that fails to build is otherwise a silent 500 in a
          // context with no console of its own.
          server.config.logger.error(
            `[patchwork] failed to bundle ${pathname}: ${error}`
          );
          response.statusCode = 500;
          response.end(`console.error(${JSON.stringify(String(error))})`);
        }
      });
    },
  };
}
