import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import external from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  // Per-chunk CSS injection keeps the entry DOM-free (it's evaluated in a
  // worker); styles ride with the lazily-imported tool chunk.
  plugins: [solidPlugin(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],
  build: {
    minify: false,
    sourcemap: true,
    cssCodeSplit: true,
    rollupOptions: {
      external,
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
