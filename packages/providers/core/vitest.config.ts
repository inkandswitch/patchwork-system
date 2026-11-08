import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["test/**/*.{test,spec}.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
