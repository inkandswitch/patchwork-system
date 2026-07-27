# @inkandswitch/patchwork-e2e

## 0.2.0

### Minor Changes

- 48e292a: Publish the e2e suite as a package with a `patchwork-e2e` bin, so any Patchwork site repo can run it against its own build. Run it from the repo root after a build; it starts the site's preview server (`pnpm preview`, overridable with `--preview-command` and `--site-dir`) and points the suite at it, writing reports and traces into the directory you ran from.

  The cross-profile sync test against a deployed site now takes its origin from `--live-site=<url>` (or `PATCHWORK_E2E_LIVE_SITE`) instead of a hardcoded patchwork.inkandswitch.com, and skips when neither is set. Also new: `--base-url` to test an already-running server, `--port`, and `--extra-tests-dir` to run a site's own specs alongside the suite as a `<browser>:extra` project — those get the same fixtures, baseURL and preview server, and can import `createDoc`, `waitForRepoReady` and friends from `@inkandswitch/patchwork-e2e/helpers`.

  The preview server now takes the first free port from 5173 up, and runs with `--strictPort`. Before, `vite preview` would quietly move to another port when 5173 was busy and the run would hang until Playwright's two-minute webServer timeout expired.

  The suite is compiled to `dist/` and published as JavaScript. Playwright does not transform files under `node_modules`, so shipping the TypeScript sources made the config unloadable for consumers.
