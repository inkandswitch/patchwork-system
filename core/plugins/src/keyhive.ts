import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

export function isKeyhiveDoc(url: AutomergeUrl): boolean {
  try {
    const { binaryDocumentId } = parseAutomergeUrl(url);
    return (
      binaryDocumentId.length >= 32 &&
      binaryDocumentId.subarray(16, 32).some((byte) => byte !== 0)
    );
  } catch {
    return false;
  }
}

type RelayingHive = { addSyncServerRelayToDoc(url: AutomergeUrl): Promise<void> };

// the docs each hive has made the sync server a relay of (or is making it one
// of), so one doc isn't given the server twice by two callers
const relayed = new WeakMap<RelayingHive, Set<string>>();

/**
 * Make the sync server a relay of the keyhive doc at `url`, once. The server
 * keeps and hands out only the docs it's a relay of, so a doc without it never
 * leaves the device that made it: no other device, and nobody it's shared
 * with, can fetch it. Resolves to whether this call added it; a doc that isn't
 * a keyhive doc, or that already has it from here, is left alone.
 */
export async function addSyncServerRelay(
  hive: RelayingHive,
  url: AutomergeUrl
): Promise<boolean> {
  if (!isKeyhiveDoc(url)) return false;
  let done = relayed.get(hive);
  if (!done) relayed.set(hive, (done = new Set()));
  if (done.has(url)) return false;
  done.add(url);
  try {
    await hive.addSyncServerRelayToDoc(url);
    return true;
  } catch (error) {
    done.delete(url);
    throw error;
  }
}
