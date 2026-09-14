import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { builtins } from "./importmap-plugin.js";

// Anchor resolution at this file (inside @inkandswitch/patchwork's own
// installed directory) rather than the site root — these worker specifiers
// are @inkandswitch/patchwork-bootloader's own exports, a transitive
// dependency of the site under strict pnpm, not resolvable from the site's
// own node_modules by bare specifier.
const self = fileURLToPath(import.meta.url);

// The service worker and the automerge shared worker are emitted as their
// own chunks. Their heavy imports are marked external and resolved to
// /packages/... URLs (both workers are created with type:"module", so the
// browser fetches those as regular network requests).
export const workers = [
  {
    specifier: "@inkandswitch/patchwork-bootloader/service-worker",
    fileName: "service-worker.js",
  },
  {
    specifier: "@inkandswitch/patchwork-bootloader/automerge-worker",
    fileName: "automerge-worker.js",
  },
  {
    specifier: "@inkandswitch/patchwork-bootloader/module-loader-worker",
    fileName: "module-loader-worker.js",
  },
];

export function serviceworker(): Plugin {
  const entryIds = new Set<string>();
  let serve = false;

  return {
    name: "@patchwork/service-worker",
    enforce: "pre",
    configResolved(config) {
      serve = config.command === "serve";
    },
    async buildStart() {
      // emitFile throws in serve mode.
      if (serve) return;
      for (const { specifier, fileName } of workers) {
        const resolved = await this.resolve(specifier, self);
        entryIds.add(resolved!.id);
        this.emitFile({
          type: "chunk",
          id: resolved!.id,
          fileName,
        });
      }
    },
    resolveId(source, importer) {
      if (importer && entryIds.has(importer) && source in builtins) {
        return { id: builtins[source], external: true };
      }
    },
  };
}
