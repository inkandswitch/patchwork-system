import type { Plugin } from "vite";
import type {
  ImportMap,
  PatchworkVitePluginOptions,
} from "./patchwork-plugin.js";
import { fileURLToPath } from "node:url";

/**
 * bootloader owns resolving/emitting its own dependencies (it's the one that
 * actually has automerge/keyhive/codemirror/solid/the other patchwork-*
 * packages as real dependencies) — reused here rather than duplicated.
 */
import externals, {
  resolveExternal,
  emitWasmAssets,
} from "@inkandswitch/patchwork-bootloader/externals";

export const builtins = externals.reduce(
  (builtins, name) => ((builtins[name] = `/packages/${name}.js`), builtins),
  {} as Record<string, string>
);

// This package importmaps itself too, so tool code loaded at runtime can
// bare-import it just like the other @inkandswitch/patchwork-* packages.
builtins["@inkandswitch/patchwork"] = "/packages/@inkandswitch/patchwork.js";

/**
 * Node resolves a package's own name from within its own source when its
 * package.json has "exports" (self-reference) — the same mechanism
 * @inkandswitch/patchwork-bootloader already relies on to list itself among
 * its own externals. Anchoring at *this* file (which lives inside
 * @inkandswitch/patchwork's own installed directory) makes that
 * self-reference resolve to this package instead of bootloader's.
 */
const self = fileURLToPath(import.meta.url);
async function resolveSelf(
  this: import("rollup").PluginContext,
  name: string
): Promise<string> {
  const resolved = await this.resolve(name, self, { skipSelf: true });
  if (!resolved) {
    throw new Error(
      `@inkandswitch/patchwork: couldn't resolve "${name}" from its own package.`
    );
  }
  return resolved.id;
}

function resolveBuiltin(
  context: import("rollup").PluginContext,
  id: string
): Promise<string> {
  return id === "@inkandswitch/patchwork"
    ? resolveSelf.call(context, id)
    : resolveExternal.call(context, id);
}

function createImportMap(options?: PatchworkVitePluginOptions) {
  const importmap: ImportMap = structuredClone(
    options?.importmap ?? { imports: {}, scopes: {} }
  );
  importmap.imports ??= {};
  importmap.scopes ??= {};
  Object.assign(importmap.imports, builtins);
  return { importmap, builtins };
}

function devDependencyId(id: string): string {
  if (id === "@inkandswitch/patchwork") return id;
  if (id === "@inkandswitch/patchwork-bootloader") {
    return `@inkandswitch/patchwork > ${id}`;
  }
  return `@inkandswitch/patchwork > @inkandswitch/patchwork-bootloader > ${id}`;
}

export function importmap(options?: PatchworkVitePluginOptions): Plugin {
  const { importmap, builtins } = createImportMap(options);
  let serve = false;
  return {
    name: "@patchwork/vite",
    config() {
      return {
        optimizeDeps: {
          include: Object.keys(builtins).map(devDependencyId),
        },
      };
    },
    configResolved(config) {
      serve = config.command === "serve";
    },
    async buildStart() {
      if (serve) return;
      for (const [id, fileName] of Object.entries(builtins)) {
        this.emitFile({
          type: "chunk",
          fileName: fileName.slice(1),
          id: await resolveBuiltin(this, id),
          preserveSignature: "strict",
        });
      }

      // Emitted so the service worker can fetch them
      emitWasmAssets.call(this);
    },
    async resolveId(id) {
      if (id in builtins) {
        // point the site's own imports at the same copy we emit as a chunk,
        // otherwise rollup bundles a second one out of the site's node_modules
        // and you end up with two automerges racing to init the same wasm
        return resolveBuiltin(this, id);
      }
      if (id in importmap.imports) {
        return { id: importmap.imports[id], external: true };
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        const activeImportmap = structuredClone(importmap);
        if (context.server) {
          for (const id of Object.keys(builtins)) {
            activeImportmap.imports[id] = `/@id/${devDependencyId(id)}`;
          }
        }
        return {
          html,
          tags: [
            {
              tag: "script",
              attrs: { type: "importmap" },
              children: JSON.stringify(activeImportmap, null, 2),
            },
          ],
        };
      },
    },
  };
}
