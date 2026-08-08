import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export type PluginManifest = {
  id: string;
  type: string;
  name?: string;
  icon?: string;
  tags?: string[];
  import: string;
  [key: string]: unknown;
};

export type PackageManifest = {
  manifest: 1;
  name?: string;
  plugins: PluginManifest[];
  permissions?: string[];
};

export type PatchworkPackage = {
  url: string;
  base: string;
  name?: string;
  permissions: string[];
  plugins: PluginManifest[];
  /** This package had no manifest; it was read by importing it. */
  legacy?: true;
};

/**
 * A list of the packages to watch: an array of urls under `modules`, a
 * name-to-url map under `packages`, or both.
 */
export type PackageListDoc = {
  modules?: AutomergeUrl[];
  packages?: Record<string, AutomergeUrl>;
};
