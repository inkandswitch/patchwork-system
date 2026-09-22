import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Source patches to @automerge/automerge-repo, applied as it passes through
 * the bundler.
 *
 * The edits are this repo's `patches/` pnpm patch, which is what
 * makes our own typecheck see the widened `role` type. A pnpm patch only
 * exists in this repo's node_modules, though: a site that installs
 * @inkandswitch/patchwork resolves automerge-repo out of its own tree and
 * would bundle it unpatched. The plugin applies the patch there too.
 *
 * The edits are upstream-shaped and meant to be deleted once subduction takes
 * them. Until then they are pinned to one automerge-repo version and every
 * hunk has to match, so a dependency bump fails the build instead of quietly
 * un-patching it.
 */
const AUTOMERGE_REPO = "@automerge/automerge-repo";
const PATCHES_DIR = fileURLToPath(new URL("../patches/", import.meta.url));
const PATCH_PREFIX = `${AUTOMERGE_REPO.replace("/", "__")}@`;

export type Hunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
};

type Patch = { version: string; files: Record<string, Hunk[]> };

export function parsePatch(text: string): Record<string, Hunk[]> {
  const files: Record<string, Hunk[]> = {};
  let hunks: Hunk[] | undefined;
  let hunk: Hunk | undefined;
  for (const line of text.split("\n")) {
    const file = /^diff --git a\/(\S+) b\//.exec(line);
    if (file) {
      hunks = /^dist\/.+\.js$/.test(file[1])
        ? (files[file[1]] = [])
        : undefined;
      hunk = undefined;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = {
        header: line,
        oldStart: +header[1],
        newStart: +header[2],
        lines: [],
      };
      hunks?.push(hunk);
      continue;
    }
    if (hunk && /^[ +-]/.test(line)) hunk.lines.push(line);
  }
  return files;
}

async function loadPatch(): Promise<Patch> {
  const names = await readdir(PATCHES_DIR).catch(() => [] as string[]);
  const found = names.filter(
    (name) => name.startsWith(PATCH_PREFIX) && name.endsWith(".patch")
  );
  if (found.length !== 1) {
    throw new Error(
      `@inkandswitch/patchwork: expected exactly one ${PATCH_PREFIX}*.patch ` +
        `in ${PATCHES_DIR}, found ${found.length}.`
    );
  }
  const version = found[0].slice(PATCH_PREFIX.length, -".patch".length);
  const text = await readFile(join(PATCHES_DIR, found[0]), "utf8");
  return { version, files: parsePatch(text) };
}

function match(id: string): { file: string; root: string } | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  const at = path.lastIndexOf(`/${AUTOMERGE_REPO}/dist/`);
  if (at === -1 || !path.endsWith(".js")) return;
  const root = path.slice(0, at) + `/${AUTOMERGE_REPO}`;
  return { file: path.slice(root.length + 1), root };
}

const versions = new Map<string, Promise<string>>();

async function assertVersion(
  root: string,
  file: string,
  expected: string
): Promise<void> {
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
  if ((await version) !== expected) {
    throw new Error(
      `@inkandswitch/patchwork: ${AUTOMERGE_REPO} is ${await version}, and the ` +
        `pnpm patch in patches/ is for ${expected}. Re-make it against the ` +
        `new version (${file} is one of the files it edits).`
    );
  }
}

function without(hunk: Hunk, prefix: string): string[] {
  return hunk.lines
    .filter((line) => line[0] !== prefix)
    .map((line) => line.slice(1));
}

export function apply(code: string, file: string, hunks: Hunk[]): string {
  const lines = code.split("\n");
  const sits = (start: number, expected: string[]) =>
    expected.every((line, i) => lines[start + i] === line);
  if (hunks.every((hunk) => sits(hunk.newStart - 1, without(hunk, "-")))) {
    return code;
  }
  let delta = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1 + delta;
    const before = without(hunk, "+");
    const after = without(hunk, "-");
    if (!sits(start, before)) {
      throw new Error(
        `@inkandswitch/patchwork: ${AUTOMERGE_REPO}'s ${file} doesn't match ` +
          `the pnpm patch at "${hunk.header}". The file is the version it ` +
          `says it is, so the patch needs re-making against it.`
      );
    }
    lines.splice(start, before.length, ...after);
    delta += after.length - before.length;
  }
  return lines.join("\n");
}

async function patchFile(
  id: string,
  patch: Patch
): Promise<string | undefined> {
  const found = match(id);
  const hunks = found && patch.files[found.file];
  if (!found || !hunks) return;
  await assertVersion(found.root, found.file, patch.version);
  return apply(await readFile(id, "utf8"), found.file, hunks);
}

export function patches({
  complete = true,
}: { complete?: boolean } = {}): Plugin {
  const seen = new Set<string>();
  let serve = false;
  let loading: Promise<Patch> | undefined;
  const patch = () => (loading ??= loadPatch());

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
                    { filter: /automerge-repo[\\/]dist[\\/]/ },
                    async ({ path }) => {
                      const contents = await patchFile(path, await patch());
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
      const { version, files } = await patch();
      const hunks = files[found.file];
      if (!hunks) return;
      await assertVersion(found.root, found.file, version);
      seen.add(found.file);
      return apply(code, found.file, hunks);
    },

    async buildEnd(error) {
      if (serve || error || !complete) return;
      const { files } = await patch();
      const missing = Object.keys(files).filter((file) => !seen.has(file));
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
