import type { StorageAdapterInterface } from "@automerge/automerge-repo/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";

const SIGNER_KEY = ["patchwork", "subduction-signer"];

/**
 * The Subduction identity every Repo on this origin presents: each tab and the
 * automerge protocol handler worker sign as the same peer. The seed is kept in
 * the same IndexedDB they already share, so it survives a reload and a new tab
 * picks it up rather than minting its own.
 *
 * Keyhive sites don't come through here — their signer is the keyhive active
 * keypair, shared by the same means.
 *
 * The read-write-read is for a cold profile, where two contexts can both find
 * nothing and both generate: whichever seed is in storage after the write is
 * the one everyone adopts.
 */
export async function loadOrCreateSigner(
  storage: StorageAdapterInterface
): Promise<MemorySigner> {
  const stored = await storage.load(SIGNER_KEY);
  if (stored) return MemorySigner.fromBytes(stored);

  await storage.save(SIGNER_KEY, crypto.getRandomValues(new Uint8Array(32)));
  const seed = await storage.load(SIGNER_KEY);
  if (!seed) throw new Error("subduction signer seed vanished after save");
  return MemorySigner.fromBytes(seed);
}
