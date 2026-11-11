import type { BuildOptions, Plugin } from "esbuild";
import process from "node:process";
import { solid } from "./plugin-solid.ts";
import pushworkSync from "./plugin-pushwork-sync.ts";
import { existsSync, rmSync } from "node:fs";
import externals from "@inkandswitch/patchwork-bootloader/externals";

const pushworking = process.argv.includes("pushwork") || process.env.PUSHWORK;

export default {
  // Single entry: the plugin array. The frame, datatypes and isolation root are
  // reached via dynamic import() from here, so `splitting` emits them as chunks.
  entryPoints: ["src/index.tsx"],
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
  // `.css` as text: `ensureFrameStyles` imports styles.css as a string and
  // injects it into whichever realm the frame mounts in (host + isolation
  // iframe). This is the esbuild equivalent of Vite's `styles.css?inline`.
  loader: { ".ttf": "dataurl", ".css": "text" },
} satisfies BuildOptions;
