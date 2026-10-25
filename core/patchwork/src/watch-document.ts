import { SedimentreeId } from "@automerge/automerge-subduction/slim";
import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import debug from "debug";
import { HEADS_CHANNEL } from "./repo.js";

const log = debug("patchwork:watch");

// A watched document has no Repo waiting on its round to pick a deadline.
const WATCH_SYNC_TIMEOUT_MS = 60_000;

/** What a Repo on the origin relays on {@link HEADS_CHANNEL} of a server's heads. */
type RemoteHeadsMessage = { kind: "remote"; sid: string; heads: string[] };

const summarize = (heads: readonly string[]) => [...heads].sort().join("|");

/**
 * Call `onChange` whenever the document at `url` may have new heads, until the
 * returned function is called, without loading it into `repo`. The tab's
 * Subduction node subscribes to the document with the server, which pushes
 * each change along with its heads. Every Repo on the origin, this tab's
 * included, relays the server's heads on the heads channel whether or not it
 * holds the document, so listening there hears this tab's pushes and other
 * tabs' writes alike: a write comes back as the heads the server acknowledges
 * it with.
 *
 * `seen` sums up the server's heads: the same `seen` twice means nothing
 * arrived in between. It isn't a version of the document: Subduction's heads
 * can include ancestors of the Automerge heads, so find the document to know
 * where it is.
 *
 * Subduction can't unsubscribe from one document, so the server keeps
 * pushing it to this tab after the watch stops; nobody's told.
 */
export function watchDocument(
  repo: Repo,
  url: AutomergeUrl,
  onChange: (seen: string) => void
): () => void {
  const { binaryDocumentId } = parseAutomergeUrl(url);
  // A document's 16 id bytes, zero-padded to 32.
  const bytes = new Uint8Array(32);
  bytes.set(binaryDocumentId.subarray(0, 32));
  const sid = SedimentreeId.fromBytes(bytes);
  const sidHex = sid.toString();
  let stopped = false;

  // The server forgets subscriptions with the connection, so this runs again
  // each time the Repo comes back online.
  const subscribe = () => {
    if (stopped || !repo.isSubductionConnected()) return;
    repo.subduction
      .then((subduction) =>
        subduction.syncWithAllPeers(sid, true, WATCH_SYNC_TIMEOUT_MS)
      )
      .catch((error) => log(`couldn't subscribe to ${url}`, error));
  };

  const onConnection = ({ connected }: { connected: boolean }) => {
    if (connected) subscribe();
  };
  const channel = new BroadcastChannel(HEADS_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RemoteHeadsMessage>) => {
    if (data?.kind === "remote" && data.sid === sidHex) {
      onChange(summarize(data.heads));
    }
  };

  repo.on("subduction-connection", onConnection);
  subscribe();

  return () => {
    stopped = true;
    repo.off("subduction-connection", onConnection);
    channel.close();
  };
}
