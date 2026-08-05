import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
} from "./registry/types.js";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

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
  if (!isValidAutomergeUrl(importUrl)) return { url: importUrl, frozen: undefined };
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
  if (hive) {
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
