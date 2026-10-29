import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";
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
import { getSupertypes } from "./datatypes.js";

import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

export type ToolImplementation<T = unknown> = ToolRender<T>;

// todo(chee): repo and hive on here might be temporary, think about it
export type ToolElement = HTMLElement & {
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
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

function datatypesOf(tool: ToolDescription): string[] {
  const datatypes = tool.supportedDatatypes;
  if (!datatypes) return [];
  return datatypes === "*" ? ["*"] : datatypes;
}

/**
 * How well `tool` fits a doc whose type and supertypes are `types` (as
 * `[type, ...getSupertypes(type)]`): the index of the nearest one it names,
 * `types.length` if it only matches through a `*` wildcard, or `undefined` if
 * it doesn't support the doc at all. Lower is a closer fit.
 */
function matchRank(tool: ToolDescription, types: string[]): number | undefined {
  const datatypes = datatypesOf(tool);
  const index = types.findIndex((type) => datatypes.includes(type));
  if (index >= 0) return index;
  if (datatypes.includes("*")) return types.length;
  return undefined;
}

/**
 * Tools that support `type`: those naming it or one of its supertypes (see
 * {@link getSupertypes}), and wildcard tools.
 */
export function getSupportedToolsForType(type: string): LoadedTool[] {
  const types = [type, ...getSupertypes(type)];
  const plugins = getRegistry<ToolDescription>("patchwork:tool").filter(
    (desc) => matchRank(desc, types) !== undefined
  );

  return plugins as LoadedTool[];
}

export function getSupportedTools(doc: HasPatchworkMetadata): LoadedTool[] {
  const type = getType(doc);
  if (!type) return [];
  return getSupportedToolsForType(type);
}

/**
 * The listed tool that fits `doc` most closely: one naming its type, then one
 * naming its nearest supertype, then a wildcard. Ties go by id.
 */
export function getFallbackTool(doc: HasPatchworkMetadata) {
  const type = getType(doc);
  if (!type) return undefined;
  const types = [type, ...getSupertypes(type)];
  return getSupportedToolsForType(type)
    .filter((tool) => !tool.unlisted)
    .sort(
      (a, b) =>
        matchRank(a, types)! - matchRank(b, types)! || a.id.localeCompare(b.id)
    )[0];
}
