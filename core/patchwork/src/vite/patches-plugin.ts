import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Source patches to @automerge/automerge-repo-subduction, applied as it
 * passes through the bundler.
 *
 * The edit is this repo's `patches/` pnpm patch: it starts a catch-up sync
 * round when a single change is stored while a round for its document is in
 * flight, so a change made right after `create()` still reaches the server.
 * A pnpm patch only exists in this repo's node_modules, though: a site that
 * installs @inkandswitch/patchwork resolves automerge-repo-subduction out of
 * its own tree and would bundle it unpatched. The plugin applies the patch
 * there too.
 *
 * The edit is upstream-shaped and meant to be deleted once automerge-repo
 * takes it. Until then each patch is pinned to one version and every hunk has
 * to match, so a dependency bump fails the build instead of quietly
 * un-patching it.
 */
const AUTOMERGE_REPO = "@automerge/automerge-repo-subduction";
const PATCHES_DIR = fileURLToPath(new URL("../patches/", import.meta.url));
const PATCH_PREFIX = `${AUTOMERGE_REPO.replace("/", "__")}@`;

export type Hunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
};

/** Each patch's hunks by the file they edit, by the version they're for. */
type Patches = Map<string, Record<string, Hunk[]>>;

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

async function loadPatches(): Promise<Patches> {
  const names = await readdir(PATCHES_DIR).catch(() => [] as string[]);
  const found = names.filter(
    (name) => name.startsWith(PATCH_PREFIX) && name.endsWith(".patch")
  );
  if (found.length === 0) {
    throw new Error(
      `@inkandswitch/patchwork: expected a ${PATCH_PREFIX}*.patch in ` +
        `${PATCHES_DIR}, found none.`
    );
  }
  const patches = await Promise.all(
    found.map(async (name) => {
      const version = name.slice(PATCH_PREFIX.length, -".patch".length);
      const text = await readFile(join(PATCHES_DIR, name), "utf8");
      return [version, parsePatch(text)] as const;
    })
  );
  return new Map(patches);
}

function match(id: string): { file: string; root: string } | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  const at = path.lastIndexOf(`/${AUTOMERGE_REPO}/dist/`);
  if (at === -1 || !path.endsWith(".js")) return;
  const root = path.slice(0, at) + `/${AUTOMERGE_REPO}`;
  return { file: path.slice(root.length + 1), root };
}

const versions = new Map<string, Promise<string>>();

function versionAt(root: string): Promise<string> {
  let version = versions.get(root);
  if (!version) {
    version = readFile(join(root, "package.json"), "utf8").then(
      (json) => JSON.parse(json).version,
      (error) => {
        throw new Error(
          `@inkandswitch/patchwork: couldn't read ${root}/package.json to ` +
            `pick the source patch written against its version. ` +
            `Has the package's layout changed? (${error})`
        );
      }
    );
    versions.set(root, version);
  }
  return version;
}

/**
 * The patch for the automerge-repo at `root`, which `file` is part of, or
 * undefined if no patch edits `file`. Throws when the version has no patch
 * but the patches for other versions edit `file`: the version moved and the
 * patch didn't move with it.
 */
async function patchFor(
  root: string,
  file: string,
  patches: Patches
): Promise<{ version: string; files: Record<string, Hunk[]> } | undefined> {
  const version = await versionAt(root);
  const files = patches.get(version);
  if (files) return files[file] ? { version, files } : undefined;
  if (![...patches.values()].some((other) => other[file])) return;
  throw new Error(
    `@inkandswitch/patchwork: ${AUTOMERGE_REPO} is ${version}, and the pnpm ` +
      `patches in patches/ are for ${[...patches.keys()].join(", ")}. ` +
      `Re-make one against the new version (${file} is one of the files ` +
      `they edit).`
  );
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
  patches: Patches
): Promise<string | undefined> {
  const found = match(id);
  const patch = found && (await patchFor(found.root, found.file, patches));
  if (!found || !patch) return;
  return apply(await readFile(id, "utf8"), found.file, patch.files[found.file]);
}

export function patches({
  complete = true,
}: { complete?: boolean } = {}): Plugin {
  // The files each version's patch was applied to.
  const seen = new Map<string, Set<string>>();
  let serve = false;
  let loading: Promise<Patches> | undefined;
  const load = () => (loading ??= loadPatches());

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
                    { filter: /automerge-repo-subduction[\\/]dist[\\/]/ },
                    async ({ path }) => {
                      const contents = await patchFile(path, await load());
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
      const patch = await patchFor(found.root, found.file, await load());
      if (!patch) return;
      const files = seen.get(patch.version) ?? new Set();
      seen.set(patch.version, files.add(found.file));
      return apply(code, found.file, patch.files[found.file]);
    },

    // A build bundles one automerge-repo, so only that version's patch has to
    // have applied in full. Bundling none of them means a layout change.
    async buildEnd(error) {
      if (serve || error || !complete) return;
      const patches = await load();
      const versions = seen.size ? [...seen.keys()] : [...patches.keys()];
      const missing = versions.flatMap((version) =>
        Object.keys(patches.get(version)!).filter(
          (file) => !seen.get(version)?.has(file)
        )
      );
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
