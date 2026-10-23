# @inkandswitch/patchwork-e2e

## 0.2.3

### Patch Changes

- 3d2d0b0: The service worker no longer mistakes a booting automerge worker for a missing one. The worker only asked for its lock once its whole import graph (most of a megabyte) had loaded, so asset requests made in that window found no lock and logged "no automerge worker; asking tabs to start one". Each tab then dropped its connection to the booting worker and reconnected sync. In a single tab that happened on every reload.

  The worker's script, `automerge-protocol-handler-worker.js`, is now a small module that takes the lock and holds on to connecting tabs before it imports the worker itself, now `@inkandswitch/patchwork-bootloader/automerge-protocol-handler`. The vite plugin emits that as a second file, `automerge-protocol-handler.js`, beside the first. As a backstop, the service worker waits three seconds before nudging, and only nudges if the request is still unanswered and there's still no lock. The nudge is throttled to once every five seconds, however many requests are waiting. Before, every request that raced the same cold start got past the throttle and logged its own nudge.

  The e2e suite gains `automerge-worker.spec.ts`, which checks that the worker holds its lock once a tab is up and that a request racing a cold worker boot isn't reported as a missing worker.

## 0.2.2

### Patch Changes

- 0bb1113: The reload-persistence test now checks that the service worker has the new doc, by reading it from a second tab, before it reloads. It used to poll the creating tab, whose own Repo answers from memory, so the reload could cut the relay mid-sync and the `find()` after it would hang until the test timed out. This happened most often in WebKit.

## 0.2.1

### Patch Changes

- a47121c: The install-tool test pastes the package URL into the Packages filter instead of typing it, since the install modal now only opens on a paste.

## 0.2.0

### Minor Changes

- 48e292a: Publish the e2e suite as a package with a `patchwork-e2e` bin, so any Patchwork site repo can run it against its own build. Run it from the repo root after a build; it starts the site's preview server (`pnpm preview`, overridable with `--preview-command` and `--site-dir`) and points the suite at it, writing reports and traces into the directory you ran from.

  The cross-profile sync test against a deployed site now takes its origin from `--live-site=<url>` (or `PATCHWORK_E2E_LIVE_SITE`) instead of a hardcoded patchwork.inkandswitch.com, and skips when neither is set. Also new: `--base-url` to test an already-running server, `--port`, and `--extra-tests-dir` to run a site's own specs alongside the suite as a `<browser>:extra` project — those get the same fixtures, baseURL and preview server, and can import `createDoc`, `waitForRepoReady` and friends from `@inkandswitch/patchwork-e2e/helpers`.

  The preview server now takes the first free port from 5173 up, and runs with `--strictPort`. Before, `vite preview` would quietly move to another port when 5173 was busy and the run would hang until Playwright's two-minute webServer timeout expired.

  The suite is compiled to `dist/` and published as JavaScript. Playwright does not transform files under `node_modules`, so shipping the TypeScript sources made the config unloadable for consumers.
