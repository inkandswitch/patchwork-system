# The package database

Status: design, 2026-11-24. Not approved yet.

## Why

Under the plugin system there's a layer core doesn't have: which packages a
page has, at which version, and what each `package.json` says. Plugins are
just one thing a `package.json` says. Put that layer in core, and the plugin
registry becomes one reader of it, so `patchwork-plugins` can move to
`packages/`.

Today `package.json` is fetched separately in several places
(`core/filesystem/src/packages.ts`, `readPluginManifest`,
`core/elements/src/package-info.ts`). The runtime-dependencies design would
add two more.

## The idea

One package database, in memory, saved to IndexedDB.

- **An entry** is a package at a version: its `package.json`, its base url,
  its plugins, and who added it. The version is the heads for an automerge
  package, or the SHA-256 of the `package.json` body for an http one.
- **Anything can add an entry**: the ModuleWatcher (for the site's package
  list and the account's), `<patchwork-view package-url>` (if there's no
  entry yet), a suggested package someone chose, or some JS through the
  deprecated `registerPlugins`. Each entry records who added it. For JS,
  that's the url it passed, plus `new Error().stack` to show a person.
- **Every version of a listed package is kept in IndexedDB.** Only entries a
  package list added are saved. Memory holds the newest version of each
  package. Lookups are against memory, so they're synchronous. Asking about
  older versions is async. Saved entries are only read back into memory when
  booting from last visit is on.
- **The database loads plugins itself**, by importing a plugin's `export`
  against the package's base url. Only the deprecated `registerPlugins` can
  hand it a live `load()`. That one gets used, and isn't saved.
- **Old `index.js` packages** get their plugins added once their entry
  point has been imported, whether in the module-loader worker or on the
  main thread. Each plugin's `export` means "the entry point, then the
  plugin with this type and id", which is what `importPluginFromPackage`
  does now.
- **Events** (added, replaced, removed, loaded) and loaded modules live in
  the database. `<patchwork-view>` and the deprecated registry share them.
- **Other tabs** hear "package X has something new, go check" on the
  database's own BroadcastChannel. Each tab's watcher then looks the package
  up itself.
- **Saved by account url**, so accounts on one origin stay apart. With no
  IndexedDB (Node, tests), it's memory only.

## Booting from last visit

A setting (a `setup()` option, with a `localStorage` override). When it's
on, views render from last visit's entries straight away, and reload in
place when the watcher finds newer heads. When it's off, boot waits for the
watcher, as now. Pick the default after trying both.

## Who owns what

The database doesn't know what a tool is. Each part of core owns the shape
it reads:

- `<patchwork-view>` owns "a tool" (`supportedDatatypes`, `unlisted`,
  `name`, render) and "a component". Its lookup returns every matching tool
  along with its package. For the default tool, it only considers packages
  that a package list added.
- The router owns "the frame tool" (the `frame-tool` tag) and `getTitle`.
- Themes move to `core/elements`. Account, `isKeyhiveDoc` and
  `createDocOfDatatype2` (which `setup().create` uses) move to
  `core/filesystem`.
- `Patchwork.plugins` is removed, so that nothing in core imports
  `patchwork-plugins`.

`patchwork-plugins` keeps its whole API, rewritten over the database and
deprecated, in `packages/plugins`. It re-exports what moved.

## Not supported

Functions in a plugin's description other than `load`, `import` and
`module`. Module urls with no `package.json`.

## Layout and rollout

- The database goes in `core/filesystem`, next to the ModuleWatcher and the
  code that loads packages. Filesystem is already in the host importmap, and
  the bootloader already depends on it.
- `core/plugins` moves to `packages/plugins` and keeps its name.
- `pinned-package-json.ts` and its changeset are deleted.

All of it is built on one branch and released together, with one changeset
for every package it touches. It's built in three steps, and chee runs each
one locally before the next:

1. Everything writes to the database. Nothing reads from it yet.
2. `<patchwork-view>`, the router, themes and `package-info.ts` read from
   it. Booting from last visit goes in here.
3. `patchwork-plugins` is rewritten on top of the database, marked
   deprecated, and moved to `packages/plugins`.

## Left to the builder

The IndexedDB schema, the exact API, when old versions get cleared out, and
which tool to mount when several share an id.
