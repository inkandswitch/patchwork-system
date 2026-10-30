import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
    // automerge-repo's DocumentQuery rejects internally-held promises when a
    // pending query is torn down after a test ends; that's upstream noise, not
    // a test failure (see patchwork-filesystem's config). This vitest has no
    // per-error filter, only the big switch.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
