# Patchwork E2E (Playwright)

Browser + Service-Worker end-to-end tests for the real boot/sync path.

These complement the in-process Vitest sync tests
(`core/filesystem/test/*.test.ts`), which only simulate Tab <-> SW with two
Node `Repo`s over a `MessageChannel`. Here we drive a real Chromium against a
built `patchwork.inkandswitch.com` served by `vite preview`, exercising SW registration,
Wasm init, IndexedDB, and the MessageChannel relay.

## Prerequisites

1. Build the site (the preview server serves `dist/`):

   ```sh
   pnpm --filter patchwork.inkandswitch.com build
   ```

2. Browsers. Either:
   - use the already-cached Playwright browsers, or
   - point at the Nix-provided driver:

     ```sh
     export PLAYWRIGHT_BROWSERS_PATH="$(nix eval --raw nixpkgs#playwright-driver.browsers)"
     ```

   `@playwright/test` is pinned to `1.59.1` to match
   `nixpkgs#playwright-driver` (chromium-1193).

## Run

```sh
pnpm --filter @inkandswitch/patchwork-e2e test:e2e          # headless
pnpm --filter @inkandswitch/patchwork-e2e test:e2e:headed   # headed
pnpm --filter @inkandswitch/patchwork-e2e test:e2e:ui       # Playwright UI
```

Or from the repo root: `pnpm test:e2e` (runs the build first).

## Run against another site repo

The package ships a `patchwork-e2e` bin. Install it in a site repo and run it
from the repo root, after a build:

```sh
pnpm add -D @inkandswitch/patchwork-e2e
pnpm exec playwright install chromium firefox webkit   # once
pnpm build
pnpm exec patchwork-e2e --live-site=https://patchwork.inkandswitch.com
```

It starts the site's own preview server (`pnpm preview`, run in the repo
root) and points the suite at it.

| flag | |
| --- | --- |
| `--live-site=<url>` | also run the cross-profile sync test against a deployed site. Omitted, that test is skipped. |
| `--base-url=<url>` | test a server that is already running; nothing is started. |
| `--port=<n>` | port for the preview server. Default: the first free one from 5173 up. Given one that's busy, it errors rather than starting. |
| `--preview-command=<cmd>` | how to serve the built site (default `pnpm preview`). |
| `--site-dir=<path>` | where to run it (default the current directory). |
| `--extra-tests-dir=<path>` | also run your own specs (see below). |

Any other argument goes straight to `playwright test`, so `--headed`,
`--ui`, `--project=chromium` and `-g "live site"` work. Reports and traces
land in the directory you ran from.

Specs under `--extra-tests-dir` run as a `<browser>:extra` project — same
fixtures, baseURL and preview server as the built-in suite. They can be
TypeScript (Playwright transpiles them; the shipped suite is compiled ahead
of time because Playwright won't transform anything under `node_modules`),
and they can use the shared helpers:

```ts
import { test } from "@playwright/test";
import { createDoc, waitForRepoReady } from "@inkandswitch/patchwork-e2e/helpers";

test("my site does its thing", async ({ page }) => {
  await page.goto("/");
  await waitForRepoReady(page);
  const url = await createDoc(page, { hello: "world" });
});
```

## Scope (Stage B1)

Current tests route only through the SW relay + IndexedDB — **no external
Subduction server**:

- `boot.spec.ts` — SW activates and the tab Repo comes up within budget.
- `multi-tab-sync.spec.ts` — a doc created in tab A is found/edited in tab B.
- `reload-persistence.spec.ts` — a doc survives a reload via IndexedDB.
- `closed-tab-persistence.spec.ts` — a doc outlives the tab that created it.
- `offline.spec.ts` — tabs sync with the network cut; the app boots from the
  SW cache offline (skipped on webkit: its offline emulation breaks reload).
- `concurrent-edits.spec.ts` — racing edits from two tabs merge losslessly.
- `base-datatypes.spec.ts` — folder-with-references and collaborative-text
  shapes from patchwork/base round-trip through the relay.

Two suites go beyond B1 and need the network (the base module bundle comes
from netlify). They run on chromium only: Playwright's Firefox build fails
cors fetches made from inside a service worker, so the module bundle (and
with it the frame) never loads, and Playwright's WebKit is too flaky on SW
timing and emulation to hold a green suite.

- `cross-profile-sync.spec.ts` — full UI boot (threepane), a markdown doc
  created via the create-new menu and edited in CodeMirror, synced between
  two browser profiles through the real Subduction server; once against the
  local build, and once against a deployed site if `--live-site` names one.
- `install-tool.spec.ts` — the extensibility loop: a one-file counter module
  (`fixtures/counter.js`) is written into a directory doc, installed from
  its `automerge:` URL through the Packages UI, created via the create-new
  menu, incremented by clicking, and survives a reload.

The offline-reload test flushed out two product fixes: the SW's cache
lookup missed entries when the request was the wasm
`<link rel=preload crossorigin>` (cors mode) rather than a plain fetch, so
offline boot 503'd — it now falls back to a url-keyed match — and hashed
`/assets/*` get `Cache-Control: immutable` (netlify `_headers` + a preview
middleware) so the browser's HTTP cache can serve the shared
automerge-protocol-handler-worker's chunk imports offline, which bypass the
page's SW.

Heads-up: repeated full-suite runs can get the machine's IP temporarily
rate-limited by netlify (the full-UI tests fetch the whole base module
bundle per boot); the full-UI tests then time out until it lifts.

Known flake, likely a real relay bug: roughly once per full run, a
cross-tab `repo.find()` for a just-created doc wedges permanently — a
stress probe showed one stall in ~60 create/find round-trips, and four
fresh `find()` calls over 20s never recovered it. Retries are enabled so
these surface as "flaky" rather than failing the run.

They assert on `window.repo` (set right after the SW relay connects), not on
full UI render: rendering the default frame needs the production Subduction
server to fetch the default-modules doc. Cross-device/server scenarios and
full-render assertions arrive in **Stage B3** once a local Subduction sync
server is wired in.

## Resource note

Config uses a single worker, no parallelism, Chromium only — intentionally
avoiding a swarm of browser/Node processes.
