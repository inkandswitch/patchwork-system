import type { Plugin } from "vite";
import wasm from "vite-plugin-wasm";
import { DEFAULT_STORAGE_PREFIX } from "@inkandswitch/patchwork-bootloader/storage";
import { DEFAULT_TITLE } from "../site-kit/options.js";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import {
  DEFAULT_SYNC_SERVERS,
  resolvePrimarySyncServer,
} from "../site-kit/sync-servers.js";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/**
 * The build-time constants both the page bundle and the workers are compiled
 * against. Values are already JSON — the shape vite's `define` and esbuild's
 * `define` both take.
 */
export function buildDefines(
  options: PatchworkVitePluginOptions = {}
): Record<string, string> {
  const classicSyncServer =
    options.syncServers && typeof options.syncServers.classic === "string"
      ? options.syncServers.classic
      : DEFAULT_SYNC_SERVERS.classic;
  return {
    __SYNC_SERVER__: JSON.stringify(resolvePrimarySyncServer(options)),
    __CLASSIC_SYNC_SERVER__: JSON.stringify(classicSyncServer),
    __SITE_TITLE__: JSON.stringify(options.title ?? DEFAULT_TITLE),
    __STORAGE_PREFIX__: JSON.stringify(
      options.storagePrefix ?? DEFAULT_STORAGE_PREFIX
    ),
  };
}

/**
 * Owns envPrefix, define (__SITE_TITLE__/__STORAGE_PREFIX__/sync-server
 * configuration),
 * server/preview CORS defaults, worker format + the wasm plugin, and build
 * defaults (firefox150 target, unminified, sourcemapped) — everything a site
 * used to hand-write in its own vite.config.ts. Each is switched off
 * individually via the matching `false` option.
 */
export function config(
  options: PatchworkVitePluginOptions = {}
): Plugin {
  return {
    name: "@patchwork/config",
    config() {
      return {
        envPrefix: ["VITE_", "PATCHWORK_"],
        define: buildDefines(options),
        optimizeDeps: {
          exclude: ["@automerge/automerge-repo-storage-indexeddb"],
          // Dep pre-bundling runs esbuild directly, outside the plugin
          // pipeline that applies `define`. Without this the page would fall
          // back to the built-in storage prefix while the workers used the
          // configured one, and they have to open the same databases.
          esbuildOptions: { define: buildDefines(options) },
        },
        server:
          options.server === false
            ? undefined
            : {
                headers: CORS_HEADERS,
                ...options.server,
              },
        preview:
          options.preview === false
            ? undefined
            : {
                port: process.env.PORT ? +process.env.PORT : 5173,
                headers: CORS_HEADERS,
                ...options.preview,
              },
        worker:
          options.worker === false
            ? undefined
            : {
                format: options.worker?.format ?? "es",
                plugins: () => [wasm()],
              },
        build: {
          target: "firefox150",
          minify: false,
          sourcemap: true,
          ...options.build,
        },
      };
    },
    // The shared automerge-worker's chunk imports bypass the page's service
    // worker, so offline boot needs the browser's HTTP cache to serve them
    // without revalidating. Content hashes make that safe; a new build gets
    // new URLs. Production gets this from the generated _headers file — vite
    // preview doesn't read that, so mirror it here.
    configurePreviewServer(server) {
      if (
        options.netlify === false ||
        options.netlify?.immutableAssets === false
      ) {
        return;
      }
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/assets/")) {
          res.setHeader(
            "Cache-Control",
            "public, max-age=31536000, immutable"
          );
        }
        next();
      });
    },
  };
}

export { wasm };
