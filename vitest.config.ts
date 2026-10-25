import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/filesystem",
      "packages/edge-handles",
    ],
  },
});
