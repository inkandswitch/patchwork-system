import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/bootloader",
      "core/filesystem",
      "packages/plugins",
      "core/patchwork",
      "packages/edge-handles",
      "packages/providers/core",
    ],
  },
});
