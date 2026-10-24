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
      for (const { specifier, fileName, hashed } of workers) {
        const resolved = await this.resolve(specifier, self);
        const ref = this.emitFile({
          type: "chunk",
          id: resolved!.id,
          ...(hashed
            ? { name: fileName.slice(0, -".js".length) }
            : { fileName }),
        });
        if (hashed) {
          files.add(`/${fileName}`, ref);
          refs.push(ref);
        }
      }
      added?.();
    },
    generateBundle: {
      // Before vite's own generateBundle, which renders the preloads.
      order: "pre",
      handler() {
        for (const ref of refs) workerFiles.add(this.getFileName(ref));
      },
    },
  };
}
