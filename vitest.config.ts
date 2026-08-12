import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: ["core/bootloader", "core/filesystem", "packages/edge-handles"],
  },
});
