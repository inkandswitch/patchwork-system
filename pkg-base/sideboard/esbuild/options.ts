import type { BuildOptions, Plugin } from "esbuild";
import process from "node:process";
import { solid } from "./plugin-solid.ts";
import pushworkSync from "./plugin-pushwork-sync.ts";
import pkgJSON from "../package.json" with { type: "json" };
import { existsSync, rmSync } from "node:fs";
import externals from "@inkandswitch/patchwork-bootloader/externals";

const pushworking = process.argv.includes("pushwork") || process.env.PUSHWORK;

export default {
  entryPoints: Object.values(pkgJSON.exports)
    .filter((dsc) => typeof dsc == "object")
    .map((dsc) => dsc.source),
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  logLevel: "debug",
  sourcemap: true,
  external: externals,
  minify: true,
  plugins: [
    solid(),
    {
      name: "empty outdir",
      setup(build) {
        build.onStart(() => {
          const { outdir, outfile } = build.initialOptions;
          if (outdir && existsSync(outdir)) rmSync(outdir, { recursive: true });
          if (outfile && existsSync(outfile)) rmSync(outfile);
        });
      },
    } satisfies Plugin,
  ].concat(pushworking ? pushworkSync() : []),
  loader: { ".ttf": "dataurl" },
} satisfies BuildOptions;
