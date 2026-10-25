import { defineConfig, devices } from "@playwright/test";

// Benchmarks, not tests: one worker, no retries, one browser at a time, so the
// numbers come from an otherwise idle browser. `pnpm bench` builds first;
// `--project=chromium` (or firefox, webkit) runs just the one.
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
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: "allow",
  },
  // Renderer memory and the memory ladder read chromium's processes over CDP,
  // so they're chromium only; elsewhere those rows are –.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Full chromium in new-headless mode, not the headless shell: the
        // shell lacks measureUserAgentSpecificMemory.
        channel: "chromium",
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm preview",
    url: `http://localhost:${PORT}`,
    timeout: 60_000,
    // A preview left behind by another checkout would serve that build.
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
  },
});
