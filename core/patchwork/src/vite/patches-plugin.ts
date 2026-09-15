import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Source patches to @automerge/automerge-repo, applied as it passes through
 * the bundler.
 *
 * The same edits live in this repo's `patches/` as a pnpm patch, which is what
 * makes our own typecheck see the widened `role` type. A pnpm patch only
 * exists in this repo's node_modules, though: a site that installs
 * @inkandswitch/patchwork resolves automerge-repo out of its own tree and
 * would bundle it unpatched. These run there too.
 *
 * Both edits are upstream-shaped and meant to be deleted once subduction takes
 * them. Until then they are pinned to one automerge-repo version and every
 * anchor has to match, so a dependency bump fails the build instead of quietly
 * un-patching it.
 */
const AUTOMERGE_REPO = "@automerge/automerge-repo";
const VERSION = "2.6.0-subduction.48";

type Edit = { find: string; replace: string };

const PATCHES: Record<string, Edit[]> = {
  "dist/subduction/AdapterConnections.js": [
    {
      find: `            if (role === "accept") {
                await subduction.acceptTransport(transport, serviceName);
            }
            else {
                await subduction.connectTransport(transport, serviceName);
            }`,
      replace: `            const initiate = role === "mesh" ? this.#localPeerId < peerId : role !== "accept";
            if (initiate) {
                await subduction.connectTransport(transport, serviceName);
            }
            else {
                await subduction.acceptTransport(transport, serviceName);
            }`,
    },
  ],
  "dist/subduction/SubductionConnections.js": [
    {
      find: `            if (state === "connecting")
                return true;`,
      replace: `            // "awaiting-reconnect" counts: the loop is between attempts, not
            // given up, so a query should wait rather than report unavailable.
            if (state === "connecting" || state === "awaiting-reconnect")
                return true;`,
    },
  ],
};

function match(id: string): { file: string; root: string } | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  for (const file of Object.keys(PATCHES)) {
    const suffix = `/${AUTOMERGE_REPO}/${file}`;
    if (path.endsWith(suffix)) {
      return {
        file,
        root: path.slice(0, -suffix.length) + `/${AUTOMERGE_REPO}`,
      };
    }
  }
}

const versions = new Map<string, Promise<string>>();

async function assertVersion(root: string, file: string): Promise<void> {
  let version = versions.get(root);
  if (!version) {
    version = readFile(join(root, "package.json"), "utf8").then(
      (json) => JSON.parse(json).version,
      (error) => {
        throw new Error(
          `@inkandswitch/patchwork: couldn't read ${root}/package.json to ` +
            `check the version the source patches are written against. ` +
            `Has the package's layout changed? (${error})`
        );
      }
    );
    versions.set(root, version);
  }
  if ((await version) !== VERSION) {
    throw new Error(
      `@inkandswitch/patchwork: ${AUTOMERGE_REPO} is ${await version}, and the ` +
        `source patches in patches-plugin.ts are written against ${VERSION}. ` +
        `Re-check them against the new version (${file} is one of the files ` +
        `they edit), then bump VERSION.`
    );
  }
}

function apply(code: string, file: string): string {
  return PATCHES[file].reduce((code, { find, replace }) => {
    if (code.includes(replace)) return code;
    const matches = code.split(find).length - 1;
    if (matches !== 1) {
      throw new Error(
        `@inkandswitch/patchwork: the source patch for ${AUTOMERGE_REPO}'s ` +
          `${file} matched ${matches} times, expected 1. The file is the ` +
          `version it says it is, so the patch needs rewriting against it.`
      );
    }
    return code.replace(find, replace);
  }, code);
}

async function patchFile(id: string): Promise<string | undefined> {
  const found = match(id);
  if (!found) return;
  await assertVersion(found.root, found.file);
  return apply(await readFile(id, "utf8"), found.file);
}

export function patches(): Plugin {
  const seen = new Set<string>();
  let serve = false;

  return {
    name: "@patchwork/patches",
    enforce: "pre",

    // Dep pre-bundling runs esbuild directly, outside the plugin pipeline that
    // applies `transform`. Without this the dev server would serve an
    // unpatched automerge-repo while the build patched it.
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: "patchwork-automerge-repo-patches",
                setup(build: {
                  onLoad(
                    options: { filter: RegExp },
                    callback: (args: {
                      path: string;
                    }) => Promise<
                      { contents: string; loader: "js" } | undefined
                    >
                  ): void;
                }) {
                  build.onLoad(
                    { filter: /automerge-repo[\\/]dist[\\/]subduction[\\/]/ },
                    async ({ path }) => {
                      const contents = await patchFile(path);
                      return contents ? { contents, loader: "js" } : undefined;
                    }
                  );
                },
              },
            ],
          },
        },
      };
    },

    configResolved(config) {
      serve = config.command === "serve";
    },

    async transform(code, id) {
      const found = match(id);
      if (!found) return;
      await assertVersion(found.root, found.file);
      seen.add(found.file);
      return apply(code, found.file);
    },

    buildEnd() {
      if (serve) return;
      const missing = Object.keys(PATCHES).filter((file) => !seen.has(file));
      if (missing.length) {
        throw new Error(
          `@inkandswitch/patchwork: ${AUTOMERGE_REPO}'s ${missing.join(", ")} ` +
            `never reached the bundler, so the source patches for them didn't ` +
            `apply. Has the package's layout changed?`
        );
      }
    },
  };
}
