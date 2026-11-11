import solid from "vite-plugin-solid";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  plugins: [
    topLevelAwait(),
    solid(),
    cssInjectedByJsPlugin({ relativeCSSInjection: true }),
  ],
  build: {
    sourcemap: true,
    cssCodeSplit: true,
    target: "esnext",
    emptyOutDir: true,
    rollupOptions: {
      external: externals,
      input: "./src/index.ts",
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
