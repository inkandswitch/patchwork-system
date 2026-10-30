import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/bootloader",
      "core/filesystem",
      "core/patchwork",
      "core/plugins",
      "packages/edge-handles",
    ],
  },
});
