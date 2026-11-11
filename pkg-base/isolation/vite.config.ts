import { defineConfig } from "vite";
import externals from "@inkandswitch/patchwork-bootloader/externals";

/**
 * Build config modeled on the other patchwork-base modules (threepane/tasks):
 * a single ES entry, `@automerge/*` + `@inkandswitch/patchwork-*` externalized
 * so they resolve through the host import map at runtime (same instances as the
 * rest of the app — no dual-package hazard).
 *
 * Two isolation-specific constraints:
 *  - `target: "esnext"` + `minify: false`: the iframe boot code in
 *    `src/boot/iframe/*` is delivered by `.toString()` (see boot/host/srcdoc.ts),
 *    so it must survive bundling as self-contained function bodies. esnext means
 *    esbuild does NOT downlevel async/await/spread into helper-referencing code
 *    that would break stringification; no-minify keeps the output auditable.
 *  - es-module-shims is intentionally NOT externalized — its source is bundled
 *    as a string (src/esms-source.generated.ts, produced by the prebuild step)
 *    because the opaque-origin iframe can't fetch it.
 */
export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
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
