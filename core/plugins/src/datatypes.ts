import { type DocHandle, type Repo } from "@automerge/automerge-repo";
import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
} from "./registry/types.js";
import {
  isHttpUrl,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import type { LegacyAutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

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

/** Creates a new document initialized with the given datatype using create2 */
export const createDocOfDatatype2 = async <D>(
  datatype: LoadedDatatype<D>,
  repo: Repo,
  change?: (doc: D) => void,
  hive?: LegacyAutomergeRepoKeyhive
): Promise<DocHandle<D & HasPatchworkMetadata>> => {
  const handle = await repo.create2<D & HasPatchworkMetadata>();
  if (hive) {
    try {
      await hive.addSyncServerRelayToDoc(handle.url);
    } catch (error) {
      console.warn(
        `createDocOfDatatype2: could not grant sync-server relay access for ${handle.url}`,
        error
      );
    }
  }
  handle.change((doc: D & HasPatchworkMetadata) => {
    datatype.module.init(doc, repo);
    // Only record an `http:`/`https:` import URL, so `suggestedImportUrl` is
    // always a directly-importable module and never an automerge/other-scheme
    // URL. See `isHttpUrl`.
    const importUrl = datatype.importUrl;
    (doc as any)["@patchwork"] = {
      type: datatype.id,
      ...(isHttpUrl(importUrl) ? { suggestedImportUrl: importUrl } : {}),
    };
    if (change) {
      change(doc);
    }
  });

  return handle;
};
