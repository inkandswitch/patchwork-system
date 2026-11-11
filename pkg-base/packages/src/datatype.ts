import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import type { ModuleSettingsDoc } from "@inkandswitch/patchwork-filesystem";

/**
 * The account's module-settings doc: its installed-packages list. The frame
 * seeds an empty one (via `ensureAccountSubdocs`) and the `packages` tool
 * reads/edits `modules`. Registered so a fresh account's subdoc bootstrap can
 * create it rather than stalling on an unregistered datatype.
 */
export const ModuleSettingsDatatype: DatatypeImplementation<ModuleSettingsDoc> =
  {
    init(doc) {
      doc["@patchwork"] = { type: "patchwork:module-settings" };
      doc.modules = [];
    },
    getTitle: (doc) =>
      (doc["@patchwork"] as { title?: string })?.title ?? "Module Settings",
    setTitle(doc, title) {
      if (!doc["@patchwork"])
        doc["@patchwork"] = { type: "patchwork:module-settings" };
      (doc["@patchwork"] as { title?: string }).title = title;
    },
  };
