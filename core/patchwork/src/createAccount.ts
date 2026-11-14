import type { Repo } from "@automerge/automerge-repo/slim";
import type {
  AccountCreator,
  AccountDoc,
} from "@inkandswitch/patchwork-plugins";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";

// the presence palette, copied from patchwork-base's account/src/user-colors.ts.
// a contact stores one of these exact strings, which is what lets a theme
// restyle it (account's themedColor maps each to a --studio-presence-* token)
const CONTACT_COLORS = [
  "hsl(200, 70%, 50%)",
  "hsl(10, 75%, 58%)",
  "hsl(145, 70%, 45%)",
  "hsl(270, 70%, 55%)",
  "hsl(38, 85%, 50%)",
  "hsl(350, 70%, 55%)",
  "hsl(178, 70%, 45%)",
  "hsl(235, 70%, 58%)",
  "hsl(85, 70%, 45%)",
  "hsl(310, 70%, 55%)",
  "hsl(25, 80%, 52%)",
  "hsl(188, 75%, 48%)",
];

const randomContactColor = () =>
  CONTACT_COLORS[Math.floor(Math.random() * CONTACT_COLORS.length)];

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
    createSubdoc<{ type: string; color: string }>(repo, "contact", (doc) => {
      doc.type = "anonymous";
      doc.color = randomContactColor();
    }),
  ]);

  accountHandle.change((doc) => {
    doc.rootFolderUrl = rootFolder.url;
    doc.moduleSettingsUrl = moduleSettings.url;
    doc.contactUrl = contact.url;
  });
};
