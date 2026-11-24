import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import process from "node:process";
import hostModules from "@inkandswitch/patchwork-bootloader/externals-list";
import type { ExternalOption, OutputOptions } from "rollup";
import { createUnplugin } from "unplugin";
import { commonOutdir, entriesFromExports, entryOutputs } from "./entries.js";

export { entriesFromExports, type Entry } from "./entries.js";

export interface Options {
  /**
   * The directory holding the package.json to build. Defaults to the
   * bundler's root (esbuild's `absWorkingDir`, vite's `root`), or the current
   * directory.
   */
  root?: string;
  /**
   * Modules the host provides that this package bundles its own copy of
   * instead, by package name: `["solid-js"]` bundles solid-js and every
   * `solid-js/…` subpath. For a package that needs a different version from
   * the host's, like Solid 2.
   */
  bundle?: string[];
  /**
   * Run `pushwork sync` in the package after each build that ends without
   * errors. Defaults to on when the command has a `pushwork` argument or
   * `PUSHWORK` is set, so `node build.ts pushwork` builds and syncs.
   */
  pushwork?: boolean;
}

interface PackageJSON {
  exports?: unknown;
}

function readPackage(root: string): PackageJSON {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

/**
 * The build every Patchwork package shares. Given no options of its own, it:
 *
 * - builds each export in package.json that has a `source`, to the path its
 *   `import` names (`"./tool": {"source": "./src/tool.tsx", "import":
 *   "./dist/tool.js"}` builds src/tool.tsx to dist/tool.js)
 * - bundles for the browser as split ES modules with sourcemaps, leaving the
 *   modules the host provides through its importmap (automerge, solid-js,
 *   the patchwork packages…) as bare imports
 * - empties the outdir before each build
 * - runs `pushwork sync` after each good build, when asked
 *
 * It does that for esbuild, vite and rollup. Any build option you set wins
 * over these defaults, and `external` (and esbuild's `loader`) are added to
 * rather than replaced. In vite, a build with `build.lib` or its own
 * `rollupOptions.input` keeps its entries, and only gets the rest.
 *
 * It doesn't compile JSX. For Solid with esbuild, add the plugin from
 * `@inkandswitch/patchwork-bundles/esbuild/solid1` or `/esbuild/solid2`.
 */
export const unplugin = createUnplugin((options: Options = {}, meta) => {
  let root = resolve(options.root ?? process.cwd());
  let pkg: PackageJSON | undefined;
  const getPackage = () => (pkg ??= readPackage(root));

  const bundled = options.bundle ?? [];
  const externals = hostModules.filter(
    (id) => !bundled.some((name) => id == name || id.startsWith(name + "/"))
  );

  /** `external` for rollup and vite: the host's modules, and yours. */
  const withExternals = (external: ExternalOption | undefined) => {
    if (typeof external == "function") {
      return ((id, ...rest) =>
        externals.includes(id) || external(id, ...rest)) as ExternalOption;
    }
    const yours = external == null ? [] : [external].flat();
    return [...new Set([...externals, ...yours])];
  };

  /** The package's entries, and the outdir their imports share. */
  const packageEntries = () => {
    const entries = entriesFromExports(getPackage().exports);
    if (!entries.length) {
      throw new Error(
        `${resolve(root, "package.json")} has no export with a ` +
          `\`source\` to build. Add one, like ` +
          `"exports": {".": {"source": "./src/index.ts", "import": ` +
          `"./dist/index.js"}}, or give the build its entries.`
      );
    }
    return { entries, outdir: commonOutdir(entries) ?? "dist" };
  };

  /** rollup's `input`: each entry, named for the path it's written to. */
  const rollupInput = (outdir: string) =>
    Object.fromEntries(
      entryOutputs(packageEntries().entries, outdir).map((entry) => [
        entry.out,
        resolve(root, entry.in),
      ])
    );

  const empty = (dir: string | undefined) => {
    if (!dir) return;
    const path = resolve(root, dir);
    // never the package itself, with an outdir of ".", or anything above it
    if (path == root || root.startsWith(path + sep)) return;
    if (existsSync(path)) rmSync(path, { recursive: true });
  };

  const pushworking =
    options.pushwork ??
    (process.argv.includes("pushwork") || !!process.env.PUSHWORK);
  let canSync: boolean | undefined;
  const sync = () => {
    if (!pushworking) return;
    if ((canSync ??= existsSync(resolve(root, ".pushwork"))) == false) {
      console.warn(
        `no .pushwork directory in ${root}, so nothing will sync. ` +
          "Run `pushwork init .` there first."
      );
      return;
    }
    try {
      execSync("pushwork sync", { cwd: root, stdio: "inherit" });
    } catch (error) {
      console.warn((error as Error).message);
    }
  };

  return {
    name: "patchwork-bundles",

    // vite and rollup only call this once the build has written its files.
    // unplugin's esbuild adapter calls it after a failed build too, so
    // esbuild syncs from its own onEnd, below
    writeBundle: meta.framework == "esbuild" ? undefined : sync,

    esbuild: {
      config(build) {
        // package.json paths are relative to the package, and esbuild's to
        // its working directory, so make them the same place
        if (options.root) build.absWorkingDir ??= root;
        else if (build.absWorkingDir) root = resolve(build.absWorkingDir);

        if (!build.entryPoints && !build.stdin) {
          const { entries, outdir } = packageEntries();
          build.outdir ??= outdir;
          build.entryPoints = entryOutputs(entries, build.outdir);
        }
        if (!build.outfile) build.outdir ??= "dist";

        build.bundle ??= true;
        build.platform ??= "browser";
        build.format ??= "esm";
        build.splitting ??= build.format == "esm" && !build.outfile;
        build.sourcemap ??= true;
        build.logLevel ??= "debug";
        // `style` for packages that export their stylesheets under it.
        // `module` is the one esbuild adds when conditions is left unset
        build.conditions ??= ["style", "module"];
        build.external = [
          ...new Set([...externals, ...(build.external ?? [])]),
        ];
        build.loader = { ".ttf": "dataurl", ...build.loader };
      },

      setup(build) {
        build.onStart(() => {
          empty(build.initialOptions.outdir ?? build.initialOptions.outfile);
        });
        build.onEnd((result) => {
          if (!result.errors.length) sync();
          else if (pushworking) {
            console.warn("the build has errors, so pushwork sync is skipped");
          }
        });
      },
    },

    rollup: {
      options(input) {
        input.input ??= rollupInput(packageEntries().outdir);
        input.external = withExternals(input.external);
        input.preserveEntrySignatures ??= "strict";
        return input;
      },
      outputOptions(output) {
        if (!output.file) output.dir ??= packageEntries().outdir;
        output.format ??= "es";
        output.entryFileNames ??= "[name].js";
        output.sourcemap ??= true;
        return output;
      },
      renderStart(output) {
        empty(output.dir);
      },
    },

    vite: {
      config(config, { command }) {
        if (!options.root && config.root) root = resolve(config.root);
        if (command != "build") return;

        // relative, so the build works wherever the host serves it from
        config.base ??= "./";
        const build = (config.build ??= {});
        build.target ??= "esnext";
        build.sourcemap ??= true;
        const rollup = (build.rollupOptions ??= {});
        rollup.external = withExternals(rollup.external);

        if (build.lib || rollup.input) return;
        build.outDir ??= packageEntries().outdir;
        rollup.input = rollupInput(build.outDir);
        rollup.preserveEntrySignatures ??= "strict";
        for (const output of [(rollup.output ??= {})].flat()) {
          (output as OutputOptions).format ??= "es";
          (output as OutputOptions).entryFileNames ??= "[name].js";
        }
      },
    },
  };
});

export default unplugin;
