---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
---

A package that fails to import in the module-loader worker now reports why. Vite's preload helper, which wraps every dynamic `import()`, announced the failure with `window.dispatchEvent`, and in a worker that threw a ReferenceError in place of the import's own error. The `patchwork()` vite plugin now includes `preloadErrorInWorkers()`, which has the helper dispatch on `globalThis` instead, and fails the build if a vite version stops writing that line. The worker also sends the error's name and message along with its stack, since Safari's and Firefox's stacks leave them out; before, Safari logged only `handlePreloadError@…`.
