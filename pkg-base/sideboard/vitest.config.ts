import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "happy-dom",
    globals: true,
    passWithNoTests: true,
    server: {
      deps: { inline: [/@inkandswitch\/patchwork-plugins/] },
    },
  },
  resolve: {
    conditions: ["development", "browser"],
    alias: {
      "@automerge/automerge-repo-keyhive": new URL(
        "./src/test/keyhive-stub.ts",
        import.meta.url
      ).pathname,
    },
  },
});
