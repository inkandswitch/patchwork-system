import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/filesystem",
      "core/patchwork",
      "packages/edge-handles",
    ],
  },
});
