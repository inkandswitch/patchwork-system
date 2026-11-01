import type { StorageAdapterInterface } from "@automerge/automerge-repo/slim";
import {
  MemorySigner,
  PeerId,
  type Signer,
} from "@automerge/automerge-subduction/slim";

const SIGNER_KEY = ["patchwork", "subduction-signer"];
const SIGNER_LOCK = "patchwork-subduction-signer";

/**
 * The Subduction identity every Repo on this origin presents: each tab and the
 * automerge protocol handler worker sign as the same peer. The seed is kept in
 * the same IndexedDB they already share, so it survives a reload and a new tab
 * picks it up rather than minting its own.
 *
 * Keyhive sites don't come through here — their signer is derived from the
 * keyhive active keypair, which ARK keeps in the keyhive storage those same
 * contexts share.
 *
 * The lock is for a cold profile. Without it two contexts both find nothing,
 * both generate, and both go on using the seed they made while only one of
 * them is the seed in storage.
 */
export async function loadOrCreateSigner(
  storage: StorageAdapterInterface
): Promise<MemorySigner> {
  return navigator.locks.request(SIGNER_LOCK, async () => {
    const stored = await storage.load(SIGNER_KEY);
    if (stored) return MemorySigner.fromBytes(stored);

    const seed = crypto.getRandomValues(new Uint8Array(32));
    await storage.save(SIGNER_KEY, seed);
    return MemorySigner.fromBytes(seed);
  });
}

/**
 * What a signer is known by: its Subduction peer id, and its verifying key in
 * hex. Every Repo passes the key as its Automerge `author`, so a document's
 * history tells which of its actors signed as this origin.
 */
export function signerIdentity(signer: Signer): {
  peerId: string;
  verifyingKey: string;
} {
  const key = signer.verifyingKey();
  return {
    peerId: new PeerId(key).toString(),
    verifyingKey: Array.from(key, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
  };
}
