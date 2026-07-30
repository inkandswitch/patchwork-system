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
 * populated by AccountDatatype.init on creation. Subdoc URLs are seeded by
 * ensureAccountSubdocs; code that reads them must still tolerate `undefined`,
 * since seeding can fail.
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
 * Also seeds the subdoc fields. See ensureAccountSubdocs.
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
      const handle = await repo.find<D & HasPatchworkMetadata>(
        stored as AutomergeUrl
      );
      await ensureAccountSubdocs(handle, repo, options.hive);
      return handle;
    } catch (error) {
      console.warn(
        `resolveAccountHandle: could not open stored account ${stored}; creating a new one`,
        error
      );
    }
  }

  const handle = await createAccount<D>(repo, options.hive);
  storage.setItem(options.storageKey, handle.url);
  await ensureAccountSubdocs(handle, repo, options.hive);
  return handle;
}

/** Account subdoc field -> the datatype that backs it. */
const ACCOUNT_SUBDOCS = [
  ["rootFolderUrl", "folder"],
  ["moduleSettingsUrl", "patchwork:module-settings"],
  ["contactUrl", "contact"],
] as const;

/** How long to wait for a subdoc's datatype to register before giving up. */
const SUBDOC_DATATYPE_TIMEOUT_MS = 10_000;

/**
 * Create any missing account subdocs.
 *
 * Stopgap for freezing this branch as a working keyhive build. Upstream the
 * frame stopped creating these (patchwork-core 0352a61) and the shell's own
 * `createAccount` took over. This branch has neither half, so nothing creates
 * them and the sidebar renders empty. Not the official approach: prefer
 * porting the upstream `createAccount` option when this branch is unfrozen.
 *
 * Runs on every resolve, not just on creation, so profiles made while the gap
 * was open are backfilled.
 */
async function ensureAccountSubdocs<D>(
  handle: DocHandle<D & HasPatchworkMetadata>,
  repo: Repo,
  hive: LegacyAutomergeRepoKeyhive | undefined
): Promise<void> {
  const datatypes = getRegistry<DatatypeDescription>("patchwork:datatype");
  const missing = (field: string) =>
    !(handle.doc() as AccountDoc | undefined)?.[field as keyof AccountDoc];

  await Promise.all(
    ACCOUNT_SUBDOCS.map(async ([field, datatypeId]) => {
      if (!missing(field)) return;
      try {
        // A datatype that never registers would hang boot, since
        // `loadWhenReady` waits forever.
        const datatype = await withTimeout(
          datatypes.loadWhenReady(datatypeId),
          SUBDOC_DATATYPE_TIMEOUT_MS,
          `datatype "${datatypeId}" did not register`
        );
        // Re-check: another tab may have set it while we waited.
        if (!missing(field)) return;
        const subdoc = await createDocOfDatatype2(
          datatype,
          repo,
          undefined,
          hive
        );
        handle.change((doc: D & HasPatchworkMetadata) => {
          const account = doc as unknown as AccountDoc;
          if (!account[field]) account[field] = subdoc.url;
        });
      } catch (error) {
        console.warn(
          `ensureAccountSubdocs: could not create ${field} for ${handle.url}`,
          error
        );
      }
    })
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() =>
    clearTimeout(timer)
  ) as Promise<T>;
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

