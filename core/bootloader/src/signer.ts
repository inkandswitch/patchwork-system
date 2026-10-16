import type { StorageAdapterInterface } from "@automerge/automerge-repo/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";

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

/** Where automerge-repo-keyhive keeps the identity's key pair, as JWK JSON. */
const KEYHIVE_KEY_PAIR_KEY = ["active-key-pair-2"];

/**
 * The Subduction signer every Repo on a keyhive site presents, read from the
 * keyhive database without starting keyhive: automerge-repo-keyhive signs
 * Subduction traffic with the keyhive identity's Ed25519 scalar
 * (`constructSubductionSigner`), and the sync node has to sign as that same
 * peer for the server to let it fetch and put.
 *
 * Every context that syncs through the node bootstraps keyhive first, which
 * creates the key pair if there isn't one, so it's normally there already;
 * otherwise this waits for it.
 */
export async function loadKeyhiveSigner(
  keyhiveStorage: StorageAdapterInterface
): Promise<MemorySigner> {
  for (;;) {
    const stored = await keyhiveStorage.load(KEYHIVE_KEY_PAIR_KEY);
    if (stored) {
      const { privateKey } = JSON.parse(new TextDecoder().decode(stored));
      const base64 = privateKey.d.replace(/-/g, "+").replace(/_/g, "/");
      return MemorySigner.fromBytes(
        Uint8Array.from(
          atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
          (c) => c.charCodeAt(0)
        )
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
