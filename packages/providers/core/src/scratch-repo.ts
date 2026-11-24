import { Repo } from "@automerge/automerge-repo/slim";

// On the realm's global under a registered symbol, so two copies of this
// module in one realm still share one scratch repo. Remappers on shells
// without `getScratchRepo` read it by this key, so don't rename it.
const KEY = Symbol.for("@inkandswitch/patchwork-providers/scratch-repo");

/**
 * The realm's scratch repo: storage-less and network-less, for documents a
 * remapper computes rather than stores (see `DocHandleDescriptor.scratchUrl`).
 * Nothing in it is saved or synced, and nothing in it is cleaned up for you:
 * whoever creates a document here deletes it when it's done with.
 *
 * Made the first time it's asked for.
 */
export function getScratchRepo(): Repo {
  const realm = globalThis as { [KEY]?: Repo };
  return (realm[KEY] ??= new Repo());
}
