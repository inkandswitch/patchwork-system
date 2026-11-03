import type { Alias, Plugin } from "vite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { exports as resolveExports } from "resolve.exports";
import type { PatchworkSiteOptions } from "../site-kit/options.js";
import { resolvePrimarySyncServer } from "../site-kit/sync-servers.js";

/**
 * The package.json of `@inkandswitch/patchwork-ark-0.6`, whose dependencies
 * are the previous keyhive stack, or undefined when this build is on the
 * current one. Resolving the stack's packages from next to it gets the old
 * ones, and so do the wasm binaries.
 */
export function arkStack(
  options: PatchworkSiteOptions = {}
): string | undefined {
  if (resolvePrimarySyncServer(options).ark !== "0.6") return;
  return require.resolve("@inkandswitch/patchwork-ark-0.6/package.json");
}

const require = createRequire(import.meta.url);

type Manifest = {
  name: string;
  exports?: unknown;
  browser?: unknown;
  module?: string;
  main?: string;
  dependencies?: Record<string, string>;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `dir` and every directory above it, nearest first. */
function ancestors(dir: string): string[] {
  const parent = dirname(dir);
  return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

/** `name`'s directory, found the way node would from inside `from`'s. */
function findPackage(name: string, from: string): string {
  const found = ancestors(dirname(from))
    .map((dir) => join(dir, "node_modules", name))
    .find((dir) => existsSync(join(dir, "package.json")));
  if (!found) {
    throw new Error(
      `@inkandswitch/patchwork: couldn't find ${name} from ${from}. Is ` +
        `@inkandswitch/patchwork-ark-0.6 installed with its dependencies?`
    );
  }
  return realpathSync(found);
}

/**
 * The file vite would pick for `subpath` of `manifest` in the browser, or
 * undefined when it has no entry there.
 */
function browserEntry(
  manifest: Manifest,
  subpath: string,
  condition: string
): string | undefined {
  try {
    return resolveExports(manifest, subpath, {
      browser: true,
      conditions: ["module", condition],
    })?.[0];
  } catch {
    return undefined;
  }
}

/** The subpaths `manifest` exports by name. Patterns are left out. */
function subpaths(exports: object): string[] {
  if (Array.isArray(exports)) return ["."];
  const keys = Object.keys(exports);
  if (!keys.every((key) => key.startsWith("."))) return ["."];
  return keys.filter((key) => !key.includes("*"));
}

function escapeRegExp(text: string): string {
  // Every character a RegExp gives a meaning to, so "@automerge/automerge-repo"
  // matches as it's written: "." and "/" both get a backslash, "a" doesn't.
  // https://regex101.com/?regex=%5B.*%2B%3F%5E%24%7B%7D()%7C%5B%5C%5D%5C%5C%5D&testString=a.b
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An alias for every subpath of every package in the stack, each matching
 * only its own specifier exactly and replaced by the absolute path of the
 * file vite would pick for it from the stack's own node_modules.
 *
 * The replacements are files rather than specifiers resolved from somewhere
 * else, so the alias is the last word: every importer gets the same file,
 * whichever package it's in, and nothing resolves past it to the current
 * copy. It also applies everywhere vite resolves, the dep optimizer and
 * worker bundles included, which plugin `resolveId` hooks don't.
 *
 * Conditions are vite's defaults for the browser: `browser`, `module`,
 * `import`, `default` and the mode's `development` or `production`.
 */
export function arkAliases(stack: string, mode: string): Alias[] {
  const condition = mode === "production" ? "production" : "development";
  return Object.keys(readManifest(stack).dependencies ?? {}).flatMap((name) => {
    const dir = findPackage(name, stack);
    const manifest = readManifest(join(dir, "package.json"));
    return manifest.exports != null
      ? exportedAliases(name, dir, manifest, condition)
      : unexportedAliases(name, dir, manifest);
  });
}

/** Exactly `specifier`, and nothing longer or shorter. */
function exactly(specifier: string): RegExp {
  // For "@automerge/automerge-repo", "@automerge/automerge-repo" and not
  // "@automerge/automerge-repo/slim", which gets an alias of its own.
  // https://regex101.com/?regex=%5E%40automerge%2Fautomerge-repo%24&testString=%40automerge%2Fautomerge-repo%2Fslim
  return new RegExp(`^${escapeRegExp(specifier)}$`);
}

/** One alias per subpath in the package's `exports`. */
function exportedAliases(
  name: string,
  dir: string,
  manifest: Manifest,
  condition: string
): Alias[] {
  const exports = manifest.exports;
  const named =
    typeof exports === "object" && exports ? subpaths(exports) : ["."];
  return named.flatMap((subpath) => {
    const target = browserEntry(manifest, subpath, condition);
    if (!target) return [];
    return [
      {
        find: exactly(name + subpath.slice(1)),
        replacement: join(dir, target),
      },
    ];
  });
}

/**
 * A package with no `exports` (ARK 0.6 is one) has its entry in the
 * `browser`, `module` or `main` field, the order vite reads them in, and any
 * deeper specifier names a file under its directory.
 */
function unexportedAliases(
  name: string,
  dir: string,
  manifest: Manifest
): Alias[] {
  const entry =
    (typeof manifest.browser === "string" ? manifest.browser : undefined) ??
    manifest.module ??
    manifest.main ??
    "index.js";
  // Anything under the package: "@automerge/automerge-repo-keyhive/dist/x.js"
  // and not "@automerge/automerge-repo-keyhive" itself, or another package
  // that starts the same, like "@automerge/automerge-repo-keyhive-extra/x.js".
  // https://regex101.com/?regex=%5E%40automerge%2Fautomerge-repo-keyhive%2F(.%2B)%24&testString=%40automerge%2Fautomerge-repo-keyhive%2Fdist%2Fx.js
  const under = new RegExp(`^${escapeRegExp(name)}/(.+)$`);
  return [
    { find: exactly(name), replacement: join(dir, entry) },
    { find: under, replacement: `${dir}/$1` },
  ];
}

/**
 * Builds against the previous keyhive stack (`keyhive.ark: "0.6"`): every
 * import of one of its packages, from anywhere, gets the copy
 * `@inkandswitch/patchwork-ark-0.6` depends on instead of the current one.
 * The pieces only work with each other (the subduction wasm objects ARK
 * passes around can't cross versions), so it's the whole stack or none of it.
 * Does nothing on the current stack.
 */
export function ark(options: PatchworkSiteOptions = {}): Plugin | undefined {
  const stack = arkStack(options);
  if (!stack) return;
  return {
    name: "@patchwork/ark-0.6",
    enforce: "pre",
    config(_, { mode }) {
      return { resolve: { alias: arkAliases(stack, mode) } };
    },
  };
}
