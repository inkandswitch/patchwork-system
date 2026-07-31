import type { Repo } from "@automerge/automerge-repo/slim";
import type {
  AccountCreator,
  AccountDoc,
} from "@inkandswitch/patchwork-plugins";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";

async function createSubdoc<D>(
  repo: Repo,
  type: string,
  init: (doc: D) => void
) {
  const handle = await repo.create2<D & HasPatchworkMetadata>();
  handle.change((doc: D & HasPatchworkMetadata) => {
    doc["@patchwork"] = { type };
    init(doc);
  });
  return handle;
}

export const createDefaultAccount: AccountCreator<AccountDoc> = async (
  accountHandle,
  repo
) => {
  const [rootFolder, moduleSettings, contact] = await Promise.all([
    createSubdoc<{ title: string; docs: unknown[] }>(repo, "folder", (doc) => {
      doc.title = "New Folder";
      doc.docs = [];
    }),
    createSubdoc<{ modules: string[] }>(
      repo,
      "patchwork:module-settings",
      (doc) => {
        doc.modules = [];
      }
    ),
    createSubdoc<{ type: string }>(repo, "contact", (doc) => {
      doc.type = "anonymous";
    }),
  ]);

  accountHandle.change((doc) => {
    doc.rootFolderUrl = rootFolder.url;
    doc.moduleSettingsUrl = moduleSettings.url;
    doc.contactUrl = contact.url;
  });
};
