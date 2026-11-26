/** Who added a package to the database. */
export type AddedBy =
  | { by: "package-list"; entry: string } // the ModuleWatcher's moduleKey
  | { by: "package-url" }
  | { by: "suggested" }
  | { by: "js"; url: string; stack: string };

/** A plugin as a package describes it: plain data, so it can be saved. */
export type PluginRecord = { type: string; id: string; export?: string } &
  Record<string, unknown>;

/** A plugin that may carry code, which only some JS can hand the database. */
export type LivePlugin = PluginRecord & {
  load?: () => Promise<unknown>;
  import?: string;
  module?: unknown;
};

/** A package at a version. */
export type PackageEntry = {
  key: string; // sourceOf(importUrl)
  version: string; // heads ("a|b"), or sha-256 hex of the package.json body
  importUrl: string; // heads-pinned automerge url, or the http url
  base?: string; // package root, ending in "/"
  packageJson?: Record<string, unknown>;
  plugins: LivePlugin[];
  addedBy: AddedBy[];
  addedAt: number;
};

/** A plugin, with the package it came from and its module once loaded. */
export type PluginView = PluginRecord & {
  importUrl: string;
  package: PackageEntry;
  module?: unknown;
};
