import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import type { LegacyAutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { getRegistry } from "./registry/index.js";
import type { DatatypeDescription } from "./datatypes.js";
import { createDocOfDatatype2 } from "./datatypes.js";

/**
 * Site-facing view of the frame's account document. Scalar tool-id fields are
 * populated by AccountDatatype.init on creation. Subdoc URLs are populated
 * lazily by the frame on first mount; code that reads them must tolerate
 * `undefined`.
 */
export type AccountDoc = {
  frameToolId: string;
  accountSidebarToolId: string;
  contextSidebarToolId: string;
  contextToolIds: string[];
  documentToolbarToolIds: string[];

  rootFolderUrl?: AutomergeUrl;
  moduleSettingsUrl?: AutomergeUrl;
  contactUrl?: AutomergeUrl;
};

/**
 * Find-or-create the account document for a site.
 *
 * The site is responsible for remembering *which* account doc to use (stashed
 * in localStorage under `storageKey`) but knows nothing about its shape. On a
 * fresh install the document is created via the `account` datatype, which
 * must be registered by the time this runs; typically that happens when the
 * `patchwork-frame` plugin bundle loads.
 *
 * Missing subdoc fields (rootFolderUrl, moduleSettingsUrl, contactUrl) are
 * intentionally left for the frame to lazily populate on mount.
 */
export async function resolveAccountHandle<D = AccountDoc>(
  repo: Repo,
  options: {
    storageKey: string;
    hive?: LegacyAutomergeRepoKeyhive;
    storage?: Pick<Storage, "getItem" | "setItem">;
  }
): Promise<DocHandle<D & HasPatchworkMetadata>> {
  const storage = options.storage ?? globalThis.localStorage;
  const stored = storage.getItem(options.storageKey);

  if (stored && isValidAutomergeUrl(stored)) {
    try {
      return await repo.find<D & HasPatchworkMetadata>(stored as AutomergeUrl);
    } catch (error) {
      console.warn(
        `resolveAccountHandle: could not open stored account ${stored}; creating a new one`,
        error
      );
    }
  }

  const handle = await createAccount<D>(repo, options.hive);
  storage.setItem(options.storageKey, handle.url);
  return handle;
}

async function createAccount<D>(
  repo: Repo,
  hive: LegacyAutomergeRepoKeyhive | undefined,
): Promise<DocHandle<D & HasPatchworkMetadata>> {
  const datatypes = getRegistry<DatatypeDescription>("patchwork:datatype");
  const accountDatatype = await datatypes.loadWhenReady("account");
  const handle = await createDocOfDatatype2<D>(accountDatatype, repo, undefined, hive);

  if (hive) {
    try {
      await hive.addSyncServerRelayToDoc(handle.url);
    } catch (error) {
      console.warn(
        `createAccount: could not grant sync-server relay access for ${handle.url}`,
        error
      );
    }
  }

  return handle;
}

