import type {
  PeerId,
  StorageAdapterInterface,
} from "@automerge/automerge-repo/slim";
import type { SyncServerIdentity } from "@automerge/automerge-repo-keyhive";

const CONTACT_CARD_KEY = ["patchwork", "sync-server-contact-card"];

/**
 * The automerge-repo-keyhive a keyhive build is made with: `"0.8"` is the
 * current stack, `"0.6"` the previous one (see
 * `@inkandswitch/patchwork-ark-0.6`) for servers that haven't moved.
 */
export type ArkVersion = "0.6" | "0.8";

/**
 * What to hand `initializeAutomergeRepoKeyhive` as its `syncServer`.
 *
 * ARK 0.8 needs the server's identity, which {@link loadSyncServerIdentity}
 * fetches from it. ARK 0.6 has no use for that: it ships the identity of
 * subduction.sync.inkandswitch.com and picks it by name, and the servers
 * still on 0.6 don't serve a contact card. The return type is 0.8's, since
 * that's the ARK this is typechecked against; the name is what 0.6 takes.
 */
export async function keyhiveSyncServer(
  syncServer: { url: string; ark?: ArkVersion },
  storage: StorageAdapterInterface
): Promise<SyncServerIdentity> {
  if (syncServer.ark === "0.6") {
    return "subduction" as unknown as SyncServerIdentity;
  }
  return loadSyncServerIdentity(syncServer.url, storage);
}

/**
 * The keyhive identity of the sync server at `url` (a ws:// or wss:// URL),
 * which serves its contact card at `/keyhive/contact-card` on the same host.
 *
 * The card is fetched on every start so a server that has been redeployed
 * with a new card is picked up. The last card fetched for each URL is kept
 * in `storage` so a start without a network still has one. Fails only when
 * no card can be fetched and none was saved for `url`.
 *
 * The card is trusted on first use. Nothing here checks it against a known
 * identity so it is only as trustworthy as the connection it came over.
 *
 * Keyhive's wasm must be initialized before this is called.
 */
export async function loadSyncServerIdentity(
  url: string,
  storage: StorageAdapterInterface
): Promise<SyncServerIdentity> {
  const { ContactCard } = await import("@automerge/automerge-repo-keyhive");
  const key = [...CONTACT_CARD_KEY, url];

  // The server's keyhive identity and its subduction peer id are the same
  // key. ARK identifies a peer by the base64 of that key.
  const identity = (contactCard: Uint8Array): SyncServerIdentity => {
    const id = ContactCard.fromBytes(contactCard).individualId.toBytes();
    const peerId = btoa(String.fromCharCode(...id)) as PeerId;
    return { contactCard, peerId };
  };

  try {
    const fetched = identity(await fetchContactCard(url));
    await storage.save(key, fetched.contactCard);
    return fetched;
  } catch (error) {
    const saved = await storage.load(key);
    if (!saved) {
      throw new Error(`no keyhive contact card for ${url}`, { cause: error });
    }
    console.warn(
      `using the saved keyhive contact card for ${url}. Fetching it failed`,
      error
    );
    return identity(saved);
  }
}

async function fetchContactCard(url: string): Promise<Uint8Array> {
  // The leading "ws" of the scheme, so "wss://host" becomes "https://host"
  // and "ws://host" "http://host". Leaves "https://host" alone.
  // https://regex101.com/?regex=%5Ews&testString=wss%3A%2F%2Fhost
  const cardUrl = new URL("/keyhive/contact-card", url.replace(/^ws/, "http"));
  const response = await fetch(cardUrl);
  if (!response.ok) {
    throw new Error(`GET ${cardUrl} responded with ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
