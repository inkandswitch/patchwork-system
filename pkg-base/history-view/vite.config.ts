import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import external from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  plugins: [solid(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],

  build: {
    sourcemap: true,
    cssCodeSplit: true,
    minify: false,
    rollupOptions: {
      external,
      input: {
        index: "./src/index.tsx",
        task: "./src/history/task.ts",
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
      preserveEntrySignatures: "strict",
    },
  },
});
