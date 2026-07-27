# @inkandswitch/patchwork

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
