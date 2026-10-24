import type { Plugin, ResolvedConfig } from "vite";
import type { PluginContext } from "rollup";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The files a build emits under content-hashed names that the dev server
 * serves at a fixed path: the `/packages/…` chunks, the wasm, and the
 * automerge worker's second stage. A fixed path can only be revalidated,
 * which a browser that's offline can't do, or cached on a guess, which mixes
 * one build's files with another's after a deploy. A hashed one can be kept
 * forever. The automerge worker's script and the service worker keep fixed
 * paths, since the browser starts them by URL across builds.
 *
 * One per build, shared by the plugins that emit these files and the ones
 * that write their URLs out.
 */
export class HashedFiles {
  #refs = new Map<string, string>();
  #urls: Map<string, string> | undefined;
  #emitting: Promise<void>[] = [];

  /**
   * Say a plugin will add files here in its buildStart, from configResolved,
   * which every plugin has had before any buildStart. Call what this returns
   * once they're added.
   */
  expect(): () => void {
    let done!: () => void;
    this.#emitting.push(new Promise<void>((resolve) => (done = resolve)));
    return done;
  }

  /** Resolves once every plugin that said it would add files has. */
  get added(): Promise<void> {
    return Promise.all(this.#emitting).then(() => {});
  }

  /** Note that the file emitted as `ref` is what's at `path` in dev. */
  add(path: string, ref: string): void {
    this.#refs.set(path, ref);
  }

  ref(path: string): string | undefined {
    return this.#refs.get(path);
  }

  /** Called in generateBundle, the first point the file names are known. */
  resolve(context: PluginContext, base: string): void {
    this.#urls = new Map(
      [...this.#refs].map(([path, ref]) => [
        path,
        `${base}${context.getFileName(ref)}`,
      ])
    );
  }

  /** Each fixed path's hashed URL. Only once the bundle is being written. */
  get urls(): ReadonlyMap<string, string> {
    if (!this.#urls) {
      throw new Error(
        "[patchwork] the hashed file names aren't known until generateBundle"
      );
    }
    return this.#urls;
  }
}

const builds = new WeakMap<ResolvedConfig, HashedFiles>();

export function hashedFiles(config: ResolvedConfig): HashedFiles {
  let files = builds.get(config);
  if (!files) builds.set(config, (files = new HashedFiles()));
  return files;
}

// Where a build leaves its table of hashed names for `vite preview`, which
// redirects the fixed paths the way a deploy's _redirects does, whether or
// not the site writes one. By output directory, so builds to two don't mix.
const tableFile = (config: ResolvedConfig) =>
  join(config.cacheDir, "patchwork-hashed.json");
const outDir = (config: ResolvedConfig) =>
  resolve(config.root, config.build.outDir);

function readTables(
  config: ResolvedConfig
): Record<string, Record<string, string>> {
  try {
    return JSON.parse(readFileSync(tableFile(config), "utf8"));
  } catch {
    return {};
  }
}

/** The hashed URL of each fixed path, as the last build to `outDir` wrote them. */
export function builtHashedFiles(config: ResolvedConfig): Map<string, string> {
  return new Map(Object.entries(readTables(config)[outDir(config)] ?? {}));
}

const self = fileURLToPath(import.meta.url);
const EMITTED = "@inkandswitch/patchwork-bootloader/emitted";

/**
 * Points everything at the hashed names in a build: the paths in the
 * bootloader's emitted.ts, which the page and the workers load these files
 * by, and the import map and wasm preloads in index.html.
 */
export function hashed(): Plugin {
  let config: ResolvedConfig;
  let files: HashedFiles;
  let emittedId: string | undefined;

  return {
    name: "@patchwork/hashed",
    configResolved(resolved) {
      config = resolved;
      files = hashedFiles(resolved);
    },
    async buildStart() {
      if (config.command !== "build") return;
      emittedId = (await this.resolve(EMITTED, self))?.id;
      if (!emittedId) {
        this.error(`couldn't resolve ${EMITTED}`);
      }
    },
    async transform(code, id) {
      if (id !== emittedId) return;
      // The bundler loads each chunk as soon as it's emitted, so this can
      // come before the rest of the files are.
      await files.added;
      // The bundler turns each into the emitted file's URL. Rollup and
      // rolldown both do this one, where resolveImportMeta is rollup's alone.
      return code.replace(/"(\/[^"]+)"/g, (_, path: string) => {
        const ref = files.ref(path);
        if (!ref) {
          this.error(
            `${path} in ${EMITTED} isn't a file this build emitted, so nothing would be there`
          );
        }
        return `import.meta.ROLLUP_FILE_URL_${ref}`;
      });
    },
    generateBundle: {
      // Before vite writes index.html, which reads the names.
      order: "pre",
      handler() {
        files.resolve(this, config.base);
      },
    },
    writeBundle() {
      const tables = readTables(config);
      tables[outDir(config)] = Object.fromEntries(files.urls);
      mkdirSync(config.cacheDir, { recursive: true });
      writeFileSync(tableFile(config), JSON.stringify(tables, null, 2));
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.bundle) return html;
        for (const [path, url] of files.urls) {
          html = html.replaceAll(`"${path}"`, `"${url}"`);
        }
        return html;
      },
    },
  };
}
