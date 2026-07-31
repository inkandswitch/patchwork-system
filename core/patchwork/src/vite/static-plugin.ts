import type { Logger, Plugin } from "vite";
import type { IncomingMessage } from "node:http";
import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createRequire } from "node:module";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";

/**
 * A tree of files to mount into the site — a package of Patchwork modules, a
 * sibling repo's build output, a single hand-written file.
 *
 * `from` is either a package specifier or a path relative to the site root. A
 * package says where its static tree lives with a `"patchwork": {"static":
 * "static-dist"}` field in its own package.json; without one, the whole
 * package directory is mounted — which is what a package that publishes its
 * static tree as the root of its own tarball wants.
 */
export interface PatchworkStaticSource {
  from: string;
  /**
   * URL path to mount `from` at. Defaults to `/`. For a file source a trailing
   * slash means "this directory, under the file's own name", so `{from:
   * "build/modules.json"}` lands at `/modules.json`.
   */
  to?: string;
  /**
   * Path, within `from`, of a file another build touches when it finishes.
   * Writing to it full-reloads the dev page, and it is never copied into the
   * site. This is how a sibling repo in watch mode drives the site's dev
   * server.
   */
  watch?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

/** Never site content, whatever a source directory happens to contain. */
const SKIP = new Set(["node_modules", ".git"]);

export interface ResolvedStaticSource extends PatchworkStaticSource {
  /** absolute path of the file or directory `from` resolved to */
  path: string;
  /** normalised mount point: "" for the site root, else "/packages/x" */
  mount: string;
  file: boolean;
  /** set when `from` was a package specifier rather than a path */
  packageDirectory?: string;
}

/**
 * Resolved from the site, not from here: the site is what depends on these
 * packages, and under pnpm this plugin lives somewhere that can't see them.
 */
function packageDirectory(name: string, root: string) {
  const require = createRequire(join(root, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // an "exports" map can hide both the manifest and the package's own main,
    // so fall back to looking for it where node would have found it
    for (const directory of require.resolve.paths(name) ?? []) {
      if (existsSync(join(directory, name, "package.json"))) {
        return join(directory, name);
      }
    }
    throw new Error(
      `[patchwork] can't find the package "${name}" — a static source has to be a dependency of the site`
    );
  }
}

/** A package's static tree: the directory it declares, or its root. */
function staticDirectory(name: string, directory: string) {
  const declared = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8")
  ).patchwork?.static;
  if (!declared) return directory;
  const path = join(directory, declared);
  if (!existsSync(path)) {
    throw new Error(
      `[patchwork] ${name} declares "patchwork": {"static": ${JSON.stringify(declared)}}, but ${path} doesn't exist. ` +
        `The field is a path inside the installed package — a package that publishes its static tree as the tarball's own root shouldn't set it at all.`
    );
  }
  return path;
}

export function resolveStatic(
  options: PatchworkVitePluginOptions,
  root: string
): ResolvedStaticSource[] {
  return (options.static ?? []).map((source) => {
    const entry = typeof source === "string" ? { from: source } : source;
    const isPath = entry.from.startsWith(".") || isAbsolute(entry.from);
    const directory = isPath ? undefined : packageDirectory(entry.from, root);
    const path = directory
      ? staticDirectory(entry.from, directory)
      : resolve(root, entry.from);
    if (!existsSync(path)) {
      throw new Error(
        `[patchwork] static source not found: ${entry.from} (${path})`
      );
    }
    const file = statSync(path).isFile();
    const to = entry.to ?? "/";
    return {
      ...entry,
      path,
      file,
      packageDirectory: directory,
      mount: (file && to.endsWith("/") ? join(to, basename(path)) : to).replace(
        /\/+$/,
        ""
      ),
    };
  });
}

function locate(source: ResolvedStaticSource, pathname: string) {
  if (source.file) return pathname === source.mount ? source.path : undefined;
  if (pathname !== source.mount && !pathname.startsWith(`${source.mount}/`)) {
    return undefined;
  }
  const path = resolve(source.path, `.${pathname.slice(source.mount.length)}`);
  const within = relative(source.path, path);
  if (within.startsWith("..")) return undefined;
  if (within.split(sep).some((part) => SKIP.has(part))) return undefined;
  if (within === source.watch) return undefined;
  if (within === "package.json" && source.packageDirectory) return undefined;
  return path;
}

/** How a source is named in messages: a specifier, or the shorter of the paths. */
function label(source: ResolvedStaticSource, root: string) {
  if (source.packageDirectory) return source.from;
  const path = relative(root, source.path);
  return path.split(sep).filter((part) => part === "..").length > 1
    ? source.path
    : path;
}

async function files(source: string, directory = source): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await files(source, path)));
    if (entry.isFile()) paths.push(relative(source, path));
  }
  return paths;
}

/**
 * Mounts `static` sources: served in dev, copied into the site at build.
 *
 * Sources never overwrite the site's own output — neither the build's, nor
 * `public/`, nor an earlier source in the list. So precedence is just list
 * order, and a site keeps its own `modules.json` by listing it before the
 * package it borrows the rest of the packages from.
 */
export function staticPlugin(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (!options.static?.length) return null;
  let sources: ResolvedStaticSource[] = [];
  let root: string;
  let outDir: string;
  let base = "/";
  let serve = false;
  let logger: Logger;
  return {
    name: "@patchwork/static",
    configResolved(config) {
      sources = resolveStatic(options, config.root);
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      base = config.base;
      serve = config.command === "serve";
      logger = config.logger;
    },
    async closeBundle() {
      // also called when a dev server shuts down, which has nothing to copy
      if (serve) return;
      for (const source of sources) {
        const paths = source.file ? [""] : await files(source.path);
        const kept: string[] = [];
        for (const path of paths) {
          if (path === source.watch) continue;
          // a package that doesn't declare a static directory mounts its whole
          // root, and its manifest isn't part of the site
          if (path === "package.json" && source.packageDirectory) continue;
          const to = join(outDir, `.${source.mount}`, path);
          await mkdir(dirname(to), { recursive: true });
          try {
            // EXCL rather than a check, so the build's own output and public/
            // win a collision no matter what order the copies happen in.
            await copyFile(
              join(source.path, path),
              to,
              constants.COPYFILE_EXCL
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            kept.push(join(source.mount, "/", path));
          }
        }
        if (kept.length) {
          logger.info(
            `[patchwork] ${label(source, root)}: ${kept.length} ${
              kept.length === 1 ? "file was" : "files were"
            } already in the site and not copied over — ${kept
              .slice(0, 5)
              .join(
                ", "
              )}${kept.length > 5 ? `, and ${kept.length - 5} more` : ""}`,
            { timestamp: true }
          );
        }
      }
    },
    configureServer(server) {
      const watched = new Map(
        sources
          .filter((source) => source.watch)
          .map((source) => [join(source.path, source.watch!), source])
      );
      for (const path of watched.keys()) server.watcher.add(path);
      server.watcher.on("change", (path) => {
        if (watched.has(path)) server.ws.send({ type: "full-reload" });
      });

      // Returned, so this runs after vite's own public/static middlewares and
      // dev matches the build: sources fill in what the site doesn't have.
      // By then the SPA fallback has rewritten req.url to /index.html, so the
      // path being asked for is the one connect saved on the way in.
      return () => {
        server.middlewares.use(async (request, response, next) => {
          const url =
            (request as IncomingMessage & { originalUrl?: string })
              .originalUrl ??
            request.url ??
            "/";
          let pathname: string;
          try {
            pathname = decodeURIComponent(
              new URL(url, "http://localhost").pathname
            );
          } catch {
            return next();
          }
          if (base !== "/" && pathname.startsWith(base)) {
            pathname = pathname.slice(base.length - 1);
          }
          for (const source of sources) {
            const path = locate(source, pathname);
            if (!path) continue;
            try {
              if (!statSync(path).isFile()) continue;
              response.setHeader("Cache-Control", "no-cache");
              response.setHeader(
                "Content-Type",
                CONTENT_TYPES[extname(path)] ?? "application/octet-stream"
              );
              response.end(await readFile(path));
              return;
            } catch {
              continue;
            }
          }
          next();
        });
      };
    },
  };
}
