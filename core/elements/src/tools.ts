import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import {
  getType,
  packages,
  type HasPatchworkMetadata,
  type PackageEntry,
  type PluginView,
} from "@inkandswitch/patchwork-filesystem";

export type ToolElement = HTMLElement & {
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
};

export type ToolRender<T = unknown> = (
  handle: DocHandle<T>,
  element: ToolElement
) => () => void;

/** A `patchwork:tool` in the package database, with the package it's from. */
export type ToolView = PluginView & {
  name: string;
  supportedDatatypes: "*" | string[];
  tags?: string[];
  unlisted?: boolean;
  forTitleBar?: boolean;
  module?: ToolRender;
};

const TOOL = "patchwork:tool";

/** The tool `id`, from the package added most recently that has one. */
export function tool(id: string): ToolView | undefined {
  return packages.plugin(TOOL, id) as ToolView | undefined;
}

/** Every tool in every package, oldest package first. */
export function tools(): ToolView[] {
  return packages.plugins(TOOL) as ToolView[];
}

/** The tools that open `type`, made for it or for anything. */
export function toolsForType(type: string): ToolView[] {
  return tools().filter(
    (tool) =>
      tool.supportedDatatypes?.includes(type) ||
      tool.supportedDatatypes?.includes("*")
  );
}

/**
 * The tool to open `doc` with when nothing asks for one: one made for its
 * type ahead of one for anything, then by id. Only from packages a package
 * list added, so some JS registering a tool doesn't take over a datatype.
 */
export function defaultTool(doc: HasPatchworkMetadata): ToolView | undefined {
  const type = getType(doc);
  if (!type) return undefined;
  const score = (tool: ToolView) => {
    const supported = [tool.supportedDatatypes].flat();
    return (
      (supported.includes(type) ? 0 : 2) + (supported.includes("*") ? 1 : 0)
    );
  };
  return (
    toolsForType(type)
      .filter(
        (tool) =>
          !tool.unlisted &&
          tool.package.addedBy.some((added) => added.by === "package-list")
      )
      // newest first, so of two with one id the newer one wins
      .reverse()
      .sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0]
  );
}

/**
 * Calls `cb` with each tool a package brings when it's added or replaced
 * (`registered`), and with each tool once its code has loaded (`loaded`).
 */
export function onToolsChange(
  cb: (event: "registered" | "loaded", view: ToolView) => void
): () => void {
  const registered = (entry: PackageEntry) => {
    for (const view of tools()) {
      if (view.package === entry) cb("registered", view);
    }
  };
  const offs = [
    packages.on("added", registered),
    packages.on("replaced", registered),
    packages.on("loaded", (view) => {
      if (view.type === TOOL) cb("loaded", view as ToolView);
    }),
  ];
  return () => offs.forEach((off) => off());
}
