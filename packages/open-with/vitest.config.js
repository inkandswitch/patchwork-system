import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The host's modules, which a page's importmap gives the tool, are a stub here.
const host = fileURLToPath(new URL("./test/host.js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@inkandswitch/patchwork-filesystem": host,
      "@inkandswitch/patchwork-elements": host,
      "@inkandswitch/patchwork-providers": host,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
