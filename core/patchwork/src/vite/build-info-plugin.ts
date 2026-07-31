import type { Plugin } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PatchworkVitePluginOptions } from "./patchwork-plugin.js";
import { resolveStatic } from "./static-plugin.js";

function revision(directory: string) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * What a package directory is: its name and version, plus the revision it was
 * built from when it isn't an installed copy. A workspace link or a checkout
 * resolves outside node_modules, and its version alone doesn't say which build
 * of it this was.
 */
function describe(directory: string) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8")
  );
  return {
    name: manifest.name,
    version: manifest.version,
    revision: directory.split(sep).includes("node_modules")
      ? undefined
      : revision(directory),
  };
}

/**
 * Writes build-info.json: what this site was built from. The site's own
 * revision, the version of patchwork that built it, and every `static` source,
 * plus whatever extra fields the site passes as the option value.
 */
export function buildInfoPlugin(
  options: PatchworkVitePluginOptions = {}
): Plugin | null {
  if (!options.buildInfo) return null;
  let root: string;
  let outDir: string;
  return {
    name: "@patchwork/build-info",
    configResolved(config) {
      root = config.root;
      outDir = join(config.root, config.build.outDir);
    },
    async closeBundle() {
      const sources = resolveStatic(options, root).map((source) =>
        source.packageDirectory
          ? { from: source.from, ...describe(source.packageDirectory) }
          : { from: source.from, revision: revision(source.path) }
      );
      await writeFile(
        join(outDir, "build-info.json"),
        `${JSON.stringify(
          {
            site: { revision: revision(root) },
            patchwork: describe(
              join(dirname(fileURLToPath(import.meta.url)), "..", "..")
            ),
            static: sources.length ? sources : undefined,
            ...(options.buildInfo === true ? {} : options.buildInfo),
          },
          null,
          2
        )}\n`
      );
    },
  };
}
