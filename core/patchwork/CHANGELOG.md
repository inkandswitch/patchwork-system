# @inkandswitch/patchwork

## 0.7.2

### Patch Changes

- e1374ad: Serve the `/packages/…` builtin URLs in dev. Import maps don't apply to worker
  scripts, so code that starts one — `@automerge/automerge-repo`'s shared
  subduction websocket worker, for instance — asks for the `/packages/…` path the
  build emits. Nothing served those in dev, and the worker failed to fetch; the
  dev server now redirects them to the same optimized dep the page's import map
  points at.
- e1374ad: Say what's actually wrong when a `static` package declares a directory that
  isn't there. The package resolved fine — its `"patchwork": {"static": …}` field
  is what's wrong — and "static source not found" named neither the field nor the
  path it pointed at. The error now quotes the declaration, gives the full path
  that's missing, and says that a package publishing its static tree as the root
  of its own tarball shouldn't set the field at all.

## 0.7.1

### Patch Changes

- 8b9206d: Don't copy `static` sources or write `build-info.json` when a dev server shuts
  down. `closeBundle` runs then too, so stopping `vite` was filling `dist/` with
  a copy of every static source.

## 0.7.0

### Minor Changes

- 5be751b: Add `static` and `buildInfo` options to the vite plugin.

  `static` mounts file trees into the site — a package of Patchwork modules, a
  sibling repo's build output, a hand-written `modules.json`. Each source is
  served by the dev server and copied into the site at build:

  ```js
  patchwork({
    static: [
      { from: "modules.json" },
      "@inkandswitch/patchwork-pkg-base",
      {
        from: "../notebook/dist",
        to: "/packages/notebook",
        watch: ".watch-ready",
      },
    ],
  });
  ```

  A source is either a package specifier or a path relative to the site root, and
  either a file or a directory. `to` mounts it somewhere other than the site root.
  `watch` names a file inside the source that another build touches when it
  finishes; writing to it full-reloads the dev page, which is how a sibling repo
  in watch mode drives the site's dev server.

  Sources never overwrite the site's own files — not the build's output, not
  `public/`, not an earlier source in the list — so precedence is list order. A
  site that wants its own `modules.json` lists it before the package it takes the
  rest of its modules from. Every file a source didn't get to write is logged at
  the end of the build, so a collision you didn't mean to have is visible.

  A package can say which of its directories is the static tree with a
  `"patchwork": {"static": "static-dist"}` field in its package.json. Without one,
  the package root is mounted (minus its manifest, `node_modules` and `.git`).

  `buildInfo` writes `build-info.json`: the site's git revision, the version and
  revision of the patchwork that built it, and every `static` source. Pass an
  object to merge extra fields into it.

  Both options are off unless set, so existing sites are unaffected.

## 0.6.1

### Patch Changes

- f37bb8e: Bump `@automerge/automerge-subduction` to 0.16.1.
- Updated dependencies [f37bb8e]
  - @inkandswitch/patchwork-bootloader@0.6.2

## 0.6.0

### Minor Changes

- 61a152a: Add a `frameToolId` option to `setup`, and stop seeding a frame tool into new accounts.

  `createDefaultAccount` wrote `frameToolId: "threepane"` into every account it created — a tool id belonging to one particular tool bundle, hardcoded in core. A site whose `packageListURL` didn't ship `threepane` gave every new user an account pointing at a tool that never registers, so the root view never mounted.

  New accounts now leave `frameToolId` unset, and the router resolves the frame each boot:

  ```
  #frame=  →  the account's frameToolId  →  setup({frameToolId})  →  first tool tagged frame-tool
  ```

  The field is still written to the account when a user picks a frame, so it stays a user preference; it is no longer decided for them at signup. Existing accounts already have it set and are unaffected.

  Sites relying on the old seeded default should pass `frameToolId: "threepane"` to `setup`.

- 61a152a: Make `vite dev` work without a site hand-rolling the dev server.

  The build emits the service worker, the automerge shared worker, the module-loader worker, and three wasm binaries. None of them existed in serve mode, so every one 404'd and dev only worked if a site served a previous production build's `dist/` behind vite. The plugin now serves all of them itself:

  - The three worker entries are bundled on demand with esbuild and rebuilt per request, so they always reflect the source on disk. Their heavy imports resolve to the dev server's optimized-dep URLs, mirroring how the build rewrites them to `/packages/...` — import maps don't apply to `type: "module"` workers, so the URLs have to be real either way.
  - `automerge.wasm`, `keyhive_wasm.wasm`, and `subduction.wasm` are served from the bootloader's own node_modules. `@inkandswitch/patchwork-bootloader/externals` gains `wasmAssets()`, which `emitWasmAssets` now uses too.
  - `global.css` 404'd in dev: the generated `index.html` links it by bare specifier, which only the build resolves. Both patchwork's and the bootloader's stylesheets are now served under root-absolute paths, and the link points at them.
  - `@patchwork/service-worker` called `emitFile` from `buildStart` unconditionally, which throws in serve mode — it logged "This plugin is likely not vite-compatible" three times on every dev-server start. It now skips emission when serving.
  - Dep pre-bundling runs esbuild outside the plugin pipeline that applies `define`, so in dev the page fell back to the default storage prefix while the workers used the configured one — the two would have opened different IndexedDB databases. The defines are now passed to the optimizer as well.

  Sites no longer need to filter `@patchwork/service-worker` out of the plugin list, serve stylesheets themselves, or keep a built `dist/` around for `vite dev`.

### Patch Changes

- 846cfac: Update the pinned `@automerge/*` versions to `2.6.0-subduction.47`. These are exact pins in `dependencies` and `peerDependencies`, so both packages need to ship the new version together — installing a `.46` and a `.47` package side by side loads two copies of automerge-repo, and document handles from one are not recognised by the other.
- Updated dependencies [846cfac]
- Updated dependencies [61a152a]
  - @inkandswitch/patchwork-bootloader@0.6.1

## 0.5.0

### Minor Changes

- 98be594: Collapse `siteName`, `title`, and `setup({name})` into a single `title`.

  A site's name was three options across two files: `siteName` and `title` in the vite config, `name` at `setup`. They fed the same handful of strings and could disagree with each other.

  `title` is now the only one. It names the html `<title>`, `apple-mobile-web-app-title`, and the manifest's `name`/`short_name` as before, and is also emitted as the `__SITE_TITLE__` define, which supplies the brand word the router appends to the document title as `"<doc> | <title>"`. It defaults to `"Patchwork"`.

  - `siteName` and the `__SITE_NAME__` define are removed. If you used `siteName` only for display, rename it to `title`; if you relied on it to namespace storage, see `storagePrefix`.
  - `setup({name})` is now `setup({title})`, and is only needed to override the build-time value.

- 98be594: Namespace IndexedDB and peer ids with a new build-time `storagePrefix` option.

  The tab and the shared automerge worker are separate bundles that must open the same databases. Both now read the name from one place, `@inkandswitch/patchwork-bootloader/storage`, resolved from the `__STORAGE_PREFIX__` define the vite plugin emits unconditionally.

  Previously each side resolved `__SITE_NAME__` itself with a different fallback — `"patchwork.inkandswitch.com"` in the worker, `"patchwork"` in the tab — so a site that never set `siteName` had its tab and worker on two different keyhive databases, and one that passed `setup({name})` split them the same way, since a runtime option never reaches the worker.

  - `storagePrefix` defaults to `"patchwork"` and is settable only in the build config. Sites sharing an origin must use distinct prefixes. It is deliberately not derived from any display name: changing it points a site at empty storage, so a rebrand must not be able to change it by accident.
  - Sites that relied on `siteName` to namespace their storage must now set `storagePrefix` explicitly to that same value to keep their existing databases.
  - `createRepo` in `@inkandswitch/patchwork` no longer takes a site name argument.

### Patch Changes

- Updated dependencies [98be594]
  - @inkandswitch/patchwork-bootloader@0.6.0

## 0.4.0

### Minor Changes

- 776b9bb: Boot no longer waits on datatypes it doesn't own. `resolveAccountHandle` writes
  the account doc directly instead of blocking on `loadWhenReady("account")`, and
  `createDefaultAccount` builds the root folder, module-settings and anonymous
  contact subdocs itself rather than waiting for the `folder`,
  `patchwork:module-settings` and `contact` datatypes. A package bundle that never
  registers those no longer hangs setup until its timeout.

  `AccountDoc.frameToolId` is now optional. `createDefaultAccount` still writes
  `"threepane"`, and the router falls back to the first registered `frame-tool`
  when an account has none.

### Patch Changes

- Updated dependencies [776b9bb]
  - @inkandswitch/patchwork-plugins@1.2.0

## 0.3.3

### Patch Changes

- Updated dependencies [eed5a2c]
  - @inkandswitch/patchwork-providers@0.5.0
  - @inkandswitch/patchwork-elements@6.0.0
  - @inkandswitch/patchwork-bootloader@0.5.4

## 0.3.2

### Patch Changes

- 5fbc712: Prebundle development import-map dependencies so dynamically loaded packages share module singletons and receive Vite's CommonJS interop.

## 0.3.1

### Patch Changes

- 896fa22: Resolve built-in import-map packages through Vite during development so the site and dynamically loaded tools share module singletons.

## 0.3.0

### Minor Changes

- 9e6e0e0: Add a `createAccount` setup option, create required account subdocuments before exposing a fresh account, and stop exposing the account handle as `window.accountDocHandle`.

### Patch Changes

- Updated dependencies [9e6e0e0]
  - @inkandswitch/patchwork-plugins@1.1.0
  - @inkandswitch/patchwork-elements@5.0.0
  - @inkandswitch/patchwork-bootloader@0.5.3

## 0.2.1

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [f00dcb8]
  - @inkandswitch/patchwork-bootloader@0.5.2
  - @inkandswitch/patchwork-filesystem@0.2.5
  - @inkandswitch/patchwork-elements@4.0.4
  - @inkandswitch/patchwork-plugins@1.0.3

## 0.2.0

### Minor Changes

- 2fffabe: `setup()` now uses `packageListURL` as given instead of letting `localStorage.systemPackageListURL` silently replace it. A site that wants a dev override resolves it itself and passes the result in:

  ```ts
  const packageListURL =
    new URLSearchParams(location.search).get("system-package-list") ||
    localStorage.getItem("systemPackageListURL") ||
    DEFAULT_PACKAGE_LIST;
  ```

  This keeps the precedence in one place — the site — so a site can add its own override sources without fighting the library for priority.

### Patch Changes

- 6be3922: Wait for configured modules to load before routing the root view so registered frame tools are available for the initial route.
- 77bd37c: Expose the account document handle as `window.accountDocHandle` alongside `window.patchwork.account`.
- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.
- Updated dependencies [5f70c14]
  - @inkandswitch/patchwork-bootloader@0.5.1
  - @inkandswitch/patchwork-filesystem@0.2.4
  - @inkandswitch/patchwork-elements@4.0.3
  - @inkandswitch/patchwork-plugins@1.0.2

## 0.1.0

### Minor Changes

- 0aa315d: Configure Subduction or Keyhive with exclusive `syncServers` configuration. `syncServers.keyhive` replaces the `keyhive` and `keyhiveSyncServer` site options and the runtime `setup({ keyhive })` option. Selecting a named ARK relay or providing a custom relay identity and URL enables Keyhive, and configured server URLs now control worker connections as well as connection hints.
- bd63259: New package: one import for a Patchwork site. It owns the boot sequence (`repo`, `router`, `loading`), the vite plugin (config, html, importmap, manifest, netlify, icons, service worker), the site-kit config helpers, and the ambient client types — all previously spread across the bootloader and each site's own `index.html`, `vite.config.ts`, and `public/` directory.

  A site is now a `package.json` dependency, a `vite.config.ts` with `patchwork({...})`, and a `main.ts` that imports `@inkandswitch/patchwork`.

### Patch Changes

- Updated dependencies [0aa315d]
- Updated dependencies [bd63259]
- Updated dependencies [bd63259]
- Updated dependencies [bd63259]
  - @inkandswitch/patchwork-bootloader@0.5.0
  - @inkandswitch/patchwork-elements@4.0.2
  - @inkandswitch/patchwork-filesystem@0.2.3
