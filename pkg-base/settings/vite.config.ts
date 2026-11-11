import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  plugins: [solid(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],

  build: {
    sourcemap: true,
    emptyOutDir: true,
    cssCodeSplit: true,
    rollupOptions: {
      external: (id) =>
        externals.some((e: string) => id === e || id.startsWith(e + "/")) ||
        id === "@inkandswitch/patchwork-providers",
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
