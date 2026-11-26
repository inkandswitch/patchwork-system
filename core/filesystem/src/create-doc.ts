import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { HasPatchworkMetadata } from "./metadata.js";
import { isKeyhiveDoc } from "./keyhive.js";

const splitImportUrl = (
  importUrl: string | undefined
): { url: string | undefined; frozen: string | undefined } => {
  if (!isValidAutomergeUrl(importUrl))
    return { url: importUrl, frozen: undefined };
  const { documentId, heads } = parseAutomergeUrl(importUrl);
  if (!heads) return { url: importUrl, frozen: undefined };
  return { url: stringifyAutomergeUrl({ documentId }), frozen: importUrl };
};

export const createDocOfDatatype2 = async <D>(
  datatype: {
    id: string;
    importUrl?: string;
    module: { init(doc: D, repo: Repo): void };
  },
  repo: Repo,
  change?: (doc: D) => void,
  // Structural, so filesystem takes no keyhive dependency.
  hive?: { addSyncServerRelayToDoc(url: AutomergeUrl): Promise<unknown> }
): Promise<DocHandle<D & HasPatchworkMetadata>> => {
  const handle = await repo.create2<D & HasPatchworkMetadata>();
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
