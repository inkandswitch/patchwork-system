import type { Plugin, ResolvedConfig } from "vite";
import { fileURLToPath } from "node:url";
import { hashedFiles } from "./hashed-plugin.js";

// Anchor resolution at this file (inside @inkandswitch/patchwork's own
// installed directory) rather than the site root — these worker specifiers
// are @inkandswitch/patchwork-bootloader's own exports, a transitive
// dependency of the site under strict pnpm, not resolvable from the site's
// own node_modules by bare specifier.
const self = fileURLToPath(import.meta.url);

// The service worker and the automerge shared worker are emitted as their
// own chunks. `fileName` is where the dev server serves each one. In a build
// the `hashed` ones are emitted under a hashed name instead (see
// hashed-plugin.ts), and loaded by the URL in the bootloader's emitted.ts; the
// others are started by URL from one build to the next, so they keep theirs.
export const workers: {
  specifier: string;
  fileName: string;
  hashed?: boolean;
}[] = [
  {
    specifier: "@inkandswitch/patchwork-bootloader/service-worker",
    fileName: "service-worker.js",
  },
  {
    specifier:
      "@inkandswitch/patchwork-bootloader/automerge-protocol-handler-worker",
    fileName: "automerge-protocol-handler-worker.js",
  },
  // What that worker's script imports once it has the lock: a separate file,
  // so the script itself has next to nothing to load first.
  {
    specifier: "@inkandswitch/patchwork-bootloader/automerge-protocol-handler",
    fileName: "automerge-protocol-handler.js",
    hashed: true,
  },
  {
    specifier: "@inkandswitch/patchwork-bootloader/module-loader-worker",
    fileName: "module-loader-worker.js",
    hashed: true,
  },
];

// The id of vite's virtual preload helper module, exactly: it matches
// "\0vite/preload-helper.js" and rejects "vite/preload-helper.js" (no \0).
// https://regex101.com/?regex=%5E%5C0vite%5C%2Fpreload-helper%5C.js%24
const PRELOAD_HELPER = /^\0vite\/preload-helper\.js$/;
const PRELOAD_ERROR_DISPATCH = "window.dispatchEvent(";
const PRELOAD_LINKS = "deps && deps.length > 0";

/**
 * Vite wraps every dynamic `import()` in its preload helper, including the
 * ones in chunks a worker shares with the page. That helper touches `window`
 * and `document`, which a worker doesn't have:
 *
 * - It preloads the import's dependencies by adding `<link>` tags to
 *   `document`. `serviceworker()` drops the dependencies of imports in a
 *   worker's own file, but a chunk shared with the page keeps them, so in a
 *   worker the import throws a ReferenceError before it starts (the automerge
 *   worker's sync-server lookup did). Skip the preloading when there's no
 *   `document`; the import itself still loads everything it needs.
 * - When the import fails, it announces it with `window.dispatchEvent`, which
 *   throws a ReferenceError in a worker and replaces the real failure with
 *   it. Dispatch on `globalThis` instead, which is `window` on the page and
 *   the worker's own scope in a worker, so the import's own error is the one
 *   that's rethrown.
 *
 * Vite has to keep writing those lines for this to work, so the build fails if
 * either is gone rather than quietly leaving workers with the ReferenceError.
 */
export function preloadErrorInWorkers(): Plugin {
  return {
    name: "@patchwork/preload-error-in-workers",
    apply: "build",
    transform: {
      filter: { id: PRELOAD_HELPER },
      handler(code, id) {
        if (!PRELOAD_HELPER.test(id)) return;
        if (!code.includes(PRELOAD_ERROR_DISPATCH)) {
          this.error(
            `vite's preload helper no longer calls ${PRELOAD_ERROR_DISPATCH}), so a failed import in a worker can't be made to report its own error; update preloadErrorInWorkers() for this vite version`
          );
        }
        if (!code.includes(PRELOAD_LINKS)) {
          this.error(
            `vite's preload helper no longer checks \`${PRELOAD_LINKS}\` before adding <link> tags, so a worker can't be made to skip them; update preloadErrorInWorkers() for this vite version`
          );
        }
        return {
          code: code
            .replaceAll(PRELOAD_ERROR_DISPATCH, "globalThis.dispatchEvent(")
            .replace(
              PRELOAD_LINKS,
              `typeof document !== "undefined" && ${PRELOAD_LINKS}`
            ),
          map: null,
        };
      },
    },
  };
}

export function serviceworker(): Plugin {
  // The files they were written to, which vite's module preloading has to
  // leave alone: it adds <link> tags to a document a worker doesn't have.
  const workerFiles = new Set(workers.map(({ fileName }) => fileName));
  const refs: string[] = [];
  let config: ResolvedConfig;
  let added: (() => void) | undefined;

  return {
    name: "@patchwork/service-worker",
    enforce: "pre",
    config() {
      return {
        build: {
          modulePreload: {
            resolveDependencies: (_url, deps, { hostId }) =>
              workerFiles.has(hostId) ? [] : deps,
          },
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
      if (resolved.command === "build") added = hashedFiles(resolved).expect();
    },
    async buildStart() {
      // emitFile throws in serve mode.
      if (config.command === "serve") return;
      const files = hashedFiles(config);
      refs.length = 0;
      const resolved = await Promise.all(
        workers.map(({ specifier }) => this.resolve(specifier, self))
      );
      workers.forEach(({ fileName, hashed }, i) => {
        const ref = this.emitFile({
          type: "chunk",
          id: resolved[i]!.id,
          ...(hashed
            ? { name: fileName.slice(0, -".js".length) }
            : { fileName }),
        });
        if (hashed) {
          files.add(`/${fileName}`, ref);
          refs.push(ref);
        }
      });
      added?.();
    },
    generateBundle: {
      // Before vite's own generateBundle, which renders the preloads.
      order: "pre",
      handler() {
        refs.forEach((ref) => workerFiles.add(this.getFileName(ref)));
      },
    },
  };
}
