import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "happy-dom",
    globals: true,
    passWithNoTests: true,
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
