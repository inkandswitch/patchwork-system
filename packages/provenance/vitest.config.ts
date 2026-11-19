import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
  },
});
