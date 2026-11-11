import { createMemo, Accessor } from "solid-js";
import {
  getType,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import { useDatatypes } from "../lib/solid-plugins";
import { isLoadedPlugin } from "@inkandswitch/patchwork-plugins/dist/registry/guards";

/**
 * Hook to compute document metadata (title)
 */
export function useDocumentMetadata(
  doc: Accessor<HasPatchworkMetadata | undefined>
) {
  const datatypes = useDatatypes();

  const title = createMemo(() => {
    const currentDoc = doc();
    if (!currentDoc) return "";
    const type = getType(currentDoc);
    const datatype = datatypes.find((dt) => dt.id === type);
    if (!datatype) return "";
    if (datatype && isLoadedPlugin(datatype) && datatype.module) {
      return datatype.module.getTitle(currentDoc);
    }
    return "";
  });

  return {
    title,
  };
}
