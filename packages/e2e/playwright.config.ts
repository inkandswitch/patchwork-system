import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E for the real browser boot: Chromium, Firefox and WebKit against a built
 * site served by `vite preview`, so service worker registration, wasm init,
 * IndexedDB and sync between tabs run for real. (The Vitest sync tests only
 * simulate them with Node Repos.)
 *
 * Each test gets its own browser context, with its own IndexedDB and service
 * worker, so they run in parallel. CI runs one browser per job; locally all
 * three run, so the worker count is halved to bound memory.
 */

// The `patchwork-e2e` bin sets these so the suite can run from the root of a
// site repo (see bin/patchwork-e2e.js). Run directly, the defaults apply.
const PORT = Number(process.env.PORT ?? 5173);
const EXTERNAL_BASE_URL = process.env.PATCHWORK_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;
const SITE_DIR = process.env.PATCHWORK_E2E_SITE_DIR ?? process.cwd();
// --strictPort so a busy port fails loudly instead of vite quietly serving
// somewhere else while playwright waits out its timeout on this one.
const PREVIEW_COMMAND =
  process.env.PATCHWORK_E2E_PREVIEW_COMMAND ??
  `pnpm preview --port ${PORT} --strictPort`;
// Reports and traces belong next to whoever invoked us, not inside the
// installed package. Relative paths would resolve against this file.
const OUTPUT_DIR = process.env.PATCHWORK_E2E_OUTPUT_DIR;
const output = (name: string) =>
  OUTPUT_DIR ? path.join(OUTPUT_DIR, name) : name;
// A site repo can point us at its own specs; they get the same fixtures,
// baseURL and preview server, as a project per browser named "<browser>:extra".
const EXTRA_TESTS_DIR = process.env.PATCHWORK_E2E_EXTRA_TESTS_DIR;

const browsers = [
  { name: "chromium", use: devices["Desktop Chrome"] },
  { name: "firefox", use: devices["Desktop Firefox"] },
  { name: "webkit", use: devices["Desktop Safari"] },
];

export default defineConfig({
  testDir: "./tests",
  // Service-worker boot + sync is inherently timing-sensitive; give each
  // test room but keep it bounded so hangs fail loudly.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  fullyParallel: true,
  workers: process.env.CI
    ? availableParallelism()
    : Math.ceil(availableParallelism() / 2),
  forbidOnly: !!process.env.CI,
  // One retry everywhere: cross-tab find() can wedge permanently (see
  // README "known flake"), and a retried pass reports as "flaky" so the
  // signal stays visible without failing the run.
  retries: 1,

  outputDir: output("test-results"),
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: output("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // COOP/COEP from the preview server require a secure-ish context;
    // localhost is treated as secure, so SharedArrayBuffer works.
    serviceWorkers: "allow",
  },

  projects: browsers.flatMap(({ name, use }) => [
    { name, use: { ...use } },
    ...(EXTRA_TESTS_DIR
      ? [{ name: `${name}:extra`, testDir: EXTRA_TESTS_DIR, use: { ...use } }]
      : []),
  ]),

  // The site must be built already; this only starts its preview server, or
  // locally reuses one you have running. With `--base-url` someone else's
  // server is used and nothing is started.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: PREVIEW_COMMAND,
        cwd: SITE_DIR,
        url: BASE_URL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        env: { PORT: String(PORT) },
      },
});
