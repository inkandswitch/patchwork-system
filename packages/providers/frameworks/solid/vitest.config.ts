import { defineConfig } from "vitest/config";

export default defineConfig({
  // Solid's node build is its server renderer, where effects never run.
  resolve: { conditions: ["browser", "development"] },
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["test/**/*.{test,spec}.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
