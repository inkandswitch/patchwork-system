import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { getRegistry } from "./registry/index.js";
import type { DatatypeDescription } from "./datatypes.js";
import { createDocOfDatatype2 } from "./datatypes.js";

/**
 * Site-facing view of the account document. Scalar tool-id fields are
 * populated by AccountDatatype.init on creation. Setup's account creator
 * populates subdoc URLs for fresh accounts; legacy accounts may lack them.
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

export type AccountCreator<D = AccountDoc> = (
  accountHandle: DocHandle<D & HasPatchworkMetadata>,
  repo: Repo
) => Promise<void>;

/**
 * Find-or-create the account document for a site.
 *
 * The site is responsible for remembering which account doc to use. On a fresh
 * install the document is created via the registered `account` datatype, then
 * passed to `createAccount` before it is stored or returned.
 */
export async function resolveAccountHandle<D = AccountDoc>(
  repo: Repo,
  options: {
    storageKey: string;
    hive?: AutomergeRepoKeyhive;
    storage?: Pick<Storage, "getItem" | "setItem">;
    createAccount?: AccountCreator<D>;
  }
): Promise<DocHandle<D & HasPatchworkMetadata>> {
  const storage = options.storage ?? globalThis.localStorage;
  const stored = storage.getItem(options.storageKey);

  if (stored && isValidAutomergeUrl(stored)) {
    // A valid stored pointer is the user's real account doc. Never fall
    // through to creating a fresh account here: a transient find failure
    // (sync layer still booting, doc briefly unavailable) would overwrite the
    // pointer and silently orphan the user's whole workspace. Retry briefly,
    // then propagate so boot fails visibly with the pointer intact.
    let lastError: unknown;
    for (const delay of [0, 500, 2_000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        return await repo.find<D & HasPatchworkMetadata>(
          stored as AutomergeUrl
        );
      } catch (error) {
        lastError = error;
        console.warn(
          `resolveAccountHandle: could not open stored account ${stored}; retrying`,
          error
        );
      }
    }
    throw new Error(
      `resolveAccountHandle: could not open the stored account ${stored}. ` +
        `Refusing to replace the stored account pointer; reload to retry ` +
        `(or clear localStorage["${options.storageKey}"] to start a fresh account).`,
      { cause: lastError }
    );
  }

  const handle = await createAccountDocument<D>(
    repo,
    options.hive,
    options.createAccount
  );
  storage.setItem(options.storageKey, handle.url);
  return handle;
}

async function createAccountDocument<D>(
  repo: Repo,
  hive: AutomergeRepoKeyhive | undefined,
  createAccount: AccountCreator<D> | undefined
): Promise<DocHandle<D & HasPatchworkMetadata>> {
  const datatypes = getRegistry<DatatypeDescription>("patchwork:datatype");
  const accountDatatype = await datatypes.loadWhenReady("account");
  const handle = await createDocOfDatatype2<D>(
    accountDatatype,
    repo,
    undefined,
    hive
  );
  await createAccount?.(handle, repo);

  return handle;
}
