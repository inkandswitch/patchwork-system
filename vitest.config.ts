import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "core/bootloader",
      "core/filesystem",
      "core/plugins",
      "core/patchwork",
      "packages/edge-handles",
      "packages/provenance",
      "packages/providers/core",
    ],
  },
});
