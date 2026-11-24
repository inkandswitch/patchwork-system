import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 30_000,
  },
});
