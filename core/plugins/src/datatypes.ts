import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
} from "./registry/types.js";
import { getRegistry } from "./registry/index.js";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { isKeyhiveDoc } from "./keyhive.js";

// Datatype implementation interface
export type DatatypeImplementation<D = unknown> = {
  init(doc: D, repo: Repo): void;
  getTitle(doc: D): string;
  setTitle?(doc: D, title: string): void;
};

// The Datatype description extends the base PluginDescription
export interface DatatypeDescription extends PluginDescription {
  type: "patchwork:datatype";
  icon: string;
  unlisted?: boolean;
  /**
   * The datatype ids this datatype is also a kind of, like a UTI's
   * `UTTypeConformsTo`. A doc of this type opens in tools that support any of
   * them (transitively). List only the direct parents. Conforming is a promise
   * that the doc also has each parent's shape, so the parents' tools can work
   * on it.
   */
  conformsTo?: string[];
}

/**
 * Every datatype `type` conforms to through `conformsTo`, transitively and
 * nearest first, not including `type` itself. Only registered datatypes
 * contribute, so the result can grow as packages register.
 */
export function getSupertypes(type: string): string[] {
  const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
  // Breadth-first, so nearer supertypes come first; `seen` also stops cycles.
  const queue = [type];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    for (const parent of registry.get(queue[i])?.conformsTo ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return queue.slice(1);
}

// Loadable Datatype description using the generic LoadablePlugin
export type Datatype<D = unknown> = LoadablePlugin<
  DatatypeDescription,
  DatatypeImplementation<D>
>;

// The complete loaded Datatype using the generic Plugin
export type LoadedDatatype<D = unknown> = LoadedPlugin<
  DatatypeDescription,
  DatatypeImplementation<D>
>;

const splitImportUrl = (
  importUrl: string | undefined
): { url: string | undefined; frozen: string | undefined } => {
  if (!isValidAutomergeUrl(importUrl))
    return { url: importUrl, frozen: undefined };
  const { documentId, heads } = parseAutomergeUrl(importUrl);
  if (!heads) return { url: importUrl, frozen: undefined };
  return { url: stringifyAutomergeUrl({ documentId }), frozen: importUrl };
};

/** Creates a new document initialized with the given datatype using create2 */
export const createDocOfDatatype2 = async <D>(
  datatype: LoadedDatatype<D>,
  repo: Repo,
  change?: (doc: D) => void,
  hive?: AutomergeRepoKeyhive
): Promise<DocHandle<D & HasPatchworkMetadata>> => {
  const handle = await repo.create2<D & HasPatchworkMetadata>();
  // Add sync server with relay access
  if (hive && isKeyhiveDoc(handle.url)) {
    await hive.addSyncServerRelayToDoc(handle.url);
  }
  handle.change((doc: D & HasPatchworkMetadata) => {
    datatype.module.init(doc, repo);
    // Record the datatype's import URL so a viewer with no built-in tool can
    // load one. It may be an `http:`/`https:` module bundle or an `automerge:`
    // folder-doc URL; both are honored on read via `getSuggestedImportUrl`.
    const { url: importUrl, frozen } = splitImportUrl(datatype.importUrl);
    (doc as any)["@patchwork"] = {
      type: datatype.id,
      ...(importUrl ? { suggestedImportUrl: importUrl } : {}),
      ...(frozen ? { frozenImportUrl: frozen } : {}),
    };
    if (change) {
      change(doc);
    }
  });

  return handle;
};
