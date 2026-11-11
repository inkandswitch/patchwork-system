import externals from "@inkandswitch/patchwork-bootloader/externals";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [],

  build: {
    // top-level await in the cross-origin virtual modules
    target: "esnext",
    sourcemap: true,
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
