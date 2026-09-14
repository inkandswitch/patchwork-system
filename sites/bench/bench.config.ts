import { defineConfig, devices } from "@playwright/test";

// Benchmarks, not tests: one worker, no retries, chromium only, so the numbers
// come from an otherwise idle browser. `pnpm bench` builds first.
const PORT = Number(process.env.PORT ?? 5199);

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  outputDir: "bench-results/artifacts",
  use: {
    ...devices["Desktop Chrome"],
    // Full chromium in new-headless mode, not the headless shell: the shell
    // lacks measureUserAgentSpecificMemory.
    channel: "chromium",
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: "allow",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "pnpm preview",
    url: `http://localhost:${PORT}`,
    timeout: 60_000,
    reuseExistingServer: true,
    env: { PORT: String(PORT) },
  },
});
