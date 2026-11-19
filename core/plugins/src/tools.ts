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
  /** The datatypes this tool opens, or `"*"` for any doc with a type. */
  supportedDatatypes?: "*" | string[];
  /**
   * Narrower claims than `supportedDatatypes`: docs of a datatype whose
   * fields match. See {@link ToolSupport}.
   */
  supports?: ToolSupport[];
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

/**
 * A kind of doc a tool opens: docs of `datatype` (`"*"` for any), narrowed by
 * `where` to those whose top-level fields match the given globs.
 *
 * `{ datatype: "file", where: { mimeType: "image/*" } }` claims image files.
 * What the fields mean is up to the datatype; core only matches strings.
 */
export type ToolSupport = {
  datatype: string;
  where?: Record<string, string>;
};

/**
 * Whether `value` matches the glob `pattern`. `*` stands for any run of
 * characters other than `/`, so `image/*` matches `image/png` but `text/*`
 * doesn't match `text/x/y`, as in Go's `path.Match`. Everything else is
 * literal and case matters.
 */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(value);
}

const isRecordOfStrings = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");

/**
 * Everything a tool claims, as {@link ToolSupport}s: one per
 * `supportedDatatypes` entry, then its `supports`. Malformed entries (a
 * package's description is anyone's JSON) are left out.
 */
export function toolSupports(
  tool: Pick<ToolDescription, "supportedDatatypes" | "supports">
): ToolSupport[] {
  const datatypes = tool.supportedDatatypes;
  const list =
    datatypes === "*" ? ["*"] : Array.isArray(datatypes) ? datatypes : [];
  const supports: ToolSupport[] = list
    .filter((d): d is string => typeof d === "string")
    .map((datatype) => ({ datatype }));
  if (Array.isArray(tool.supports)) {
    for (const s of tool.supports as unknown[]) {
      const support = s as Partial<ToolSupport> | null;
      if (typeof support?.datatype !== "string") continue;
      if (support.where === undefined) {
        supports.push({ datatype: support.datatype });
      } else if (isRecordOfStrings(support.where)) {
        supports.push({ datatype: support.datatype, where: support.where });
      }
    }
  }
  return supports;
}

/**
 * How a tool takes a doc, best first:
 * - `exact`: a `where` matched with literal values (`text/markdown`)
 * - `glob`: a `where` matched through a glob (`text/*`)
 * - `datatype`: it lists the doc's datatype
 * - `wildcard`: only through a `"*"` datatype, as a generic viewer like raw
 *   does
 *
 * A `where` pattern made only of `*` and `/` (`*\/*`) says nothing about the
 * doc beyond having the field, so it counts as no `where` at all.
 */
export type ToolMatch = "exact" | "glob" | "datatype" | "wildcard";

const MATCH_ORDER: ToolMatch[] = ["exact", "glob", "datatype", "wildcard"];

const saysNothing = (pattern: string) => /^[*/]*$/.test(pattern);

// Any `where` narrows: even `*\/*` leaves out docs without the field.
const narrows = (support: ToolSupport) =>
  Object.keys(support.where ?? {}).length > 0;

function supportMatch(
  support: ToolSupport,
  type: string,
  doc: Record<string, unknown>
): ToolMatch | undefined {
  if (support.datatype !== "*" && support.datatype !== type) return undefined;
  let glob = false;
  let exact = false;
  for (const [field, pattern] of Object.entries(support.where ?? {})) {
    const value = doc[field];
    if (typeof value !== "string" || !globMatch(pattern, value)) {
      return undefined;
    }
    if (saysNothing(pattern)) continue;
    if (pattern.includes("*")) glob = true;
    else exact = true;
  }
  if (glob) return "glob";
  if (exact) return "exact";
  return support.datatype === "*" ? "wildcard" : "datatype";
}

const rank = (match: ToolMatch | undefined) =>
  match === undefined ? Infinity : MATCH_ORDER.indexOf(match);

/** How `tool` takes `doc`, by its best claim, or `undefined` if it doesn't. */
export function toolMatch(
  tool: Pick<ToolDescription, "supportedDatatypes" | "supports">,
  doc: unknown
): ToolMatch | undefined {
  const type = getType((doc ?? {}) as HasPatchworkMetadata);
  if (!type) return undefined;
  let best: ToolMatch | undefined;
  for (const support of toolSupports(tool)) {
    const match = supportMatch(support, type, doc as Record<string, unknown>);
    if (rank(match) < rank(best)) best = match;
  }
  return best;
}

/** Whether `tool` opens any doc with a type, as raw does. */
export function opensAnything(
  tool: Pick<ToolDescription, "supportedDatatypes" | "supports">
): boolean {
  return toolSupports(tool).some((s) => s.datatype === "*" && !narrows(s));
}

/** The doc fields some registered tool's `where` reads. */
export function whereFields(): Set<string> {
  const fields = new Set<string>();
  for (const tool of getRegistry<ToolDescription>("patchwork:tool").all()) {
    for (const s of toolSupports(tool)) {
      for (const field of Object.keys(s.where ?? {})) fields.add(field);
    }
  }
  return fields;
}

/**
 * The tools that open every doc of `type`: those that claim it, or `"*"`,
 * with no `where` narrowing it to some of them.
 */
export function getSupportedToolsForType(type: string): LoadedTool[] {
  return getRegistry<ToolDescription>("patchwork:tool").filter((desc) =>
    toolSupports(desc).some(
      (s) => (s.datatype === type || s.datatype === "*") && !narrows(s)
    )
  ) as LoadedTool[];
}

export function getSupportedTools(doc: HasPatchworkMetadata): LoadedTool[] {
  return getRegistry<ToolDescription>("patchwork:tool").filter(
    (desc) => toolMatch(desc, doc) !== undefined
  ) as LoadedTool[];
}

/**
 * The tool to open a doc with when none is chosen: the best match (see
 * {@link ToolMatch}), then by id.
 */
export function getFallbackTool(doc: HasPatchworkMetadata) {
  const byMatch = (tool: LoadedTool) => rank(toolMatch(tool, doc));
  return getSupportedTools(doc)
    .filter((tool) => !tool.unlisted)
    .sort((a, b) => byMatch(a) - byMatch(b) || a.id.localeCompare(b.id))[0];
}
