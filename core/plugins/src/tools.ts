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
import { getSupertypes, type DatatypeDescription } from "./datatypes.js";

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

function datatypeDepths(type: string): Map<string, number> {
  const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
  const depths = new Map([[type, 0]]);
  const queue = [type];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const parent of registry.get(current)?.conformsTo ?? []) {
      if (depths.has(parent)) continue;
      depths.set(parent, depths.get(current)! + 1);
      queue.push(parent);
    }
  }
  return depths;
}

/**
 * How well `tool` fits a doc: the minimum inheritance depth of a datatype it
 * names, the depth after the farthest supertype for a `*` wildcard, or
 * `undefined` if it doesn't support the doc. Lower is a closer fit.
 */
function matchRank(
  tool: ToolDescription,
  depths: Map<string, number>
): number | undefined {
  const datatypes = datatypesOf(tool);
  const namedDepths = datatypes
    .map((type) => depths.get(type))
    .filter((depth): depth is number => depth !== undefined);
  if (namedDepths.length > 0) return Math.min(...namedDepths);
  if (datatypes.includes("*")) return depths.size;
  return undefined;
}

/**
 * Tools that support `type`: those naming it or one of its supertypes (see
 * {@link getSupertypes}), and wildcard tools.
 */
export function getSupportedToolsForType(type: string): LoadedTool[] {
  const depths = datatypeDepths(type);
  const plugins = getRegistry<ToolDescription>("patchwork:tool").filter(
    (desc) => matchRank(desc, depths) !== undefined
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
  const depths = datatypeDepths(type);
  return getSupportedToolsForType(type)
    .filter((tool) => !tool.unlisted)
    .sort(
      (a, b) =>
        matchRank(a, depths)! - matchRank(b, depths)! ||
        a.id.localeCompare(b.id)
    )[0];
}
