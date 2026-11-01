import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/filesystem",
      "core/patchwork",
      "packages/edge-handles",
      "packages/providers/frameworks/react",
      "packages/providers/frameworks/solid",
      "packages/undo",
    ],
  },
});
