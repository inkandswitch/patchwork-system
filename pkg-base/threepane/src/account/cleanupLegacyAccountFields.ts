import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { AccountDoc } from "../types";

/**
 * Opt-in, manual cleanup: removes the legacy account fields that have been
 * migrated into the threepane config doc. NOT run automatically — only call this
 * once the threepane migration has shipped everywhere and you no longer need to
 * switch back to a build that reads these fields.
 *
 * Safe to run only after `account.tools.threepane` is set (i.e. migrated).
 */
export function cleanupLegacyAccountFields(
  accountHandle: DocHandle<AccountDoc>
): { removed: string[] } {
  const account = accountHandle.doc();
  if (!account?.tools?.["threepane"]) {
    console.warn(
      "cleanupLegacyAccountFields: not migrated yet (no tools.threepane); skipping"
    );
    return { removed: [] };
  }

  // `contextToolIds` isn't part of `AccountDoc`, but older docs may still
  // carry it.
  const legacyFields: (keyof AccountDoc | "contextToolIds")[] = [
    "accountSidebarToolId",
    "contextToolIds",
    "documentToolbarToolIds",
  ];

  const removed: string[] = [];
  accountHandle.change((doc) => {
    for (const field of legacyFields) {
      if (field in doc) {
        delete (doc as Record<string, unknown>)[field];
        removed.push(field);
      }
    }
  });

  console.info("cleanupLegacyAccountFields: removed", removed);
  return { removed };
}
