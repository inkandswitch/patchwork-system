import type { BuildOptions, Plugin } from "esbuild";
import externals from "@inkandswitch/patchwork-bootloader/externals";
import process from "node:process";
import { existsSync, rmSync } from "node:fs";
import { solid } from "./plugin-solid.ts";
import pushworkSync from "./plugin-pushwork-sync.ts";
import pkgJSON from "../package.json" with { type: "json" };

const pushworking = process.argv.includes("pushwork") || process.env.PUSHWORK;

export default {
  entryPoints: Object.values(pkgJSON.exports)
    .filter((dsc) => typeof dsc == "object" && "source" in dsc)
    .map((dsc) => dsc.source),
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  logLevel: "debug",
  sourcemap: true,
  external: externals,
  plugins: [
    solid(),
    {
      name: "empty outdir",
      setup(build) {
        build.onStart(() => {
          const { outdir } = build.initialOptions;
          if (outdir && existsSync(outdir)) rmSync(outdir, { recursive: true });
        });
      },
    } satisfies Plugin,
  ].concat(pushworking ? [pushworkSync()] : []),
  loader: { ".ttf": "dataurl" },
  conditions: ["style", "browser", "import"],
} satisfies BuildOptions;
