import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import type {
  AccountCreator,
  AccountDoc,
} from "@inkandswitch/patchwork-plugins";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";

export async function createSubdoc<D>(
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

/**
 * Show `/packages` in the account's tree: a link named `packages` in its root
 * folder, to the packages folder, unless the root folder already has an entry
 * by that name. The `/packages` mount shadows a same-named entry in `/`, so the
 * link means the same thing; renaming or removing it changes only the view.
 */
export async function linkPackagesIntoRoot(
  repo: Repo,
  rootFolderUrl: AutomergeUrl | undefined,
  packagesFolderUrl: AutomergeUrl
): Promise<void> {
  if (!rootFolderUrl) return;
  const root = await repo.find<{ docs?: Array<{ name: string }> }>(rootFolderUrl);
  if (!Array.isArray(root.doc()?.docs)) return;
  if (root.doc()!.docs!.some((entry) => String(entry?.name) === "packages")) return;
  root.change((doc) => {
    doc.docs!.push({ name: "packages", type: "folder", url: packagesFolderUrl } as never);
  });
}

export const createDefaultAccount: AccountCreator<AccountDoc> = async (
  accountHandle,
  repo
) => {
  const [rootFolder, packagesFolder, moduleSettings, contact] = await Promise.all([
    createSubdoc<{ title: string; docs: unknown[] }>(repo, "folder", (doc) => {
      doc.title = "New Folder";
      doc.docs = [];
    }),
    createSubdoc<{ title: string; docs: unknown[] }>(repo, "folder", (doc) => {
      doc.title = "Packages";
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
    doc.namespace = {
      "/": [{ url: rootFolder.url }],
      // Package management: whatever is bound here.
      "/packages": [{ url: packagesFolder.url }],
    };
    // Still made: the Packages UI installs into it.
    doc.moduleSettingsUrl = moduleSettings.url;
    doc.contactUrl = contact.url;
  });
  await linkPackagesIntoRoot(repo, rootFolder.url, packagesFolder.url);
};
