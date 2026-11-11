import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { getRegistry, isLoadedPlugin } from "@inkandswitch/patchwork-plugins";
import type {
  DocLink,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";

// Resolve a bare automerge url into a DocLink by reading the doc's
// patchwork metadata and asking its datatype for a title
export async function docLinkFromUrl(
  repo: Repo,
  url: AutomergeUrl
): Promise<DocLink> {
  const handle = await repo.find<Partial<HasPatchworkMetadata>>(url);
  const doc = handle.doc();
  const type = doc?.["@patchwork"]?.type ?? "";
  let name = "Untitled";

  if (type) {
    const registry = getRegistry("patchwork:datatype");
    const datatype = registry.get(type);
    if (datatype) {
      await registry.load(datatype.id);
      if (isLoadedPlugin(datatype)) {
        name = datatype.module.getTitle(doc) || name;
      }
    }
  }

  return { name, type, url };
}
