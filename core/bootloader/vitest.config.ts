import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
  },
});
