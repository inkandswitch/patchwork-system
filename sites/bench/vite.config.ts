import { defineConfig } from "vite";
import patchwork from "@inkandswitch/patchwork/vite";

export default defineConfig({
  plugins: [
    patchwork({
      title: "bench",
      storagePrefix: "bench",
      manifest: false,
      netlify: false,
      buildInfo: false,
      // Cross-origin isolation unlocks performance.measureUserAgentSpecificMemory,
      // which is how the benches attribute memory to workers.
      preview: {
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
      },
    }),
  ],
});
