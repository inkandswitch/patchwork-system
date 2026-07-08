import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
} from "./registry/index.js";
import {
  getType,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "./registry/index.js";

import type { LegacyAutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

export type ToolImplementation<T = unknown> = ToolRender<T>;

// todo(chee): repo and hive on here might be temporary, think about it
export type ToolElement = HTMLElement & {
  repo: Repo;
  hive?: LegacyAutomergeRepoKeyhive;
};

export type ToolRender<T = unknown> = (
  handle: DocHandle<T>,
  element: ToolElement
) => () => void;

// todo this will be in the package.json
export type ToolDescription = PluginDescription & {
  id: string;
  tags?: string[];
  type: "patchwork:tool";
  supportedDatatypes: "*" | string[];
  name: string;
  icon?: string;
  unlisted?: boolean;
  forTitleBar?: boolean;
};

export type LoadedTool<T = unknown> = LoadedPlugin<
  ToolDescription,
  ToolImplementation<T>
>;

export type Tool<T = unknown> = LoadablePlugin<
  ToolDescription,
  ToolImplementation<T>
>;

export type LegacyEditorProps = { docUrl: AutomergeUrl };

export function getSupportedToolsForType(type: string): LoadedTool[] {
  const plugins = getRegistry<ToolDescription>("patchwork:tool").filter(
    (desc) => {
      return (
        desc.supportedDatatypes?.includes(type) ||
        desc.supportedDatatypes?.includes("*")
      );
    }
  );

  return plugins as LoadedTool[];
}

export function getSupportedTools(doc: HasPatchworkMetadata): LoadedTool[] {
  const type = getType(doc);
  if (!type) return [];
  return getSupportedToolsForType(type);
}

export function getFallbackTool(doc: HasPatchworkMetadata) {
  const type = getType(doc)!;
  const plugins = getSupportedTools(doc);
  return sortPlugins<LoadedTool, ToolDescription, ToolImplementation>(
    plugins,
    "supportedDatatypes",
    type,
    "id"
  )?.filter((tool) => !tool.unlisted)?.[0];
}

const sortPlugins = <
  T extends LoadedPlugin<D, I>,
  D extends PluginDescription,
  I,
>(
  plugins: T[],
  matchField: keyof D,
  matchValue: string,
  sortField?: keyof D
): T[] => {
  return [...plugins].sort((a, b) => {
    const aValue = a[matchField];
    const bValue = b[matchField];

    // Convert string values to arrays for consistent comparison
    const aArray = Array.isArray(aValue)
      ? (aValue as string[])
      : [aValue as string];
    const bArray = Array.isArray(bValue)
      ? (bValue as string[])
      : [bValue as string];

    const aHasWildcard = aArray.includes("*");
    const bHasWildcard = bArray.includes("*");
    const aHasMatch = aArray.includes(matchValue);
    const bHasMatch = bArray.includes(matchValue);

    // Specific matches come first
    if (aHasMatch && !bHasMatch) return -1;
    if (!aHasMatch && bHasMatch) return 1;

    // Then wildcard matches come last
    if (aHasWildcard && !bHasWildcard) return 1;
    if (!aHasWildcard && bHasWildcard) return -1;

    // If both are wildcards or both are specific matches, sort by the optional sort field
    if (sortField) {
      const aSort = a[sortField];
      const bSort = b[sortField];
      if (typeof aSort === "string" && typeof bSort === "string") {
        return aSort.localeCompare(bSort);
      }
    }

    return 0;
  });
};
