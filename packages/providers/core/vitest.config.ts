import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["test/**/*.{test,spec}.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    // `gc()` for the tests that check derived handles can be collected.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
  },
});
