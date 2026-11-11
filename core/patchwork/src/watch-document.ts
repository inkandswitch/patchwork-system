import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  sedimentreeId,
  type SedimentreeBackend,
} from "@automerge/automerge-repo/sedimentree";
import debug from "debug";

const log = debug("patchwork:watch");

/** One report of a document's heads from a peer (the sync server). */
export type ServerHeads = {
  /** The reporting peer (the sync server's hex verifying key). */
  peerId: string;
  /** Its heads, as hex commit ids. */
  heads: string[];
  timestamp: number;
};

/**
 * Hear every report of the document `documentId`'s heads from the sync
 * server, until the returned function is called, without loading it into a
 * Repo: a session of its own on `backend` (the tab's port to the automerge
 * worker) is opened, and only its `remote-heads` are read. The worker holds
 * the document, and subscribes to it with the server, while any session is
 * open.
 */
export function watchServerHeads(
  backend: SedimentreeBackend,
  documentId: DocumentId,
  onHeads: (report: ServerHeads) => void
): () => void {
  const { binaryDocumentId } = parseAutomergeUrl(
    `automerge:${documentId}` as AutomergeUrl
  );
  const session = backend.open(sedimentreeId(binaryDocumentId));
  let stopped = false;
  void (async () => {
    try {
      for await (const event of session.events) {
        if (stopped) return;
        if (event.type !== "remote-heads") continue;
        onHeads({
          peerId: event.remote.id,
          heads: [...event.heads],
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      if (!stopped) log(`stopped watching ${documentId}`, error);
    }
  })();
  return () => {
    stopped = true;
    void session.close();
  };
}

/**
 * Call `onChange` whenever the document at `url` may have new heads, until the
 * returned function is called, without loading it into `repo`. The server
 * pushes each change to the automerge worker with its heads, and a write from
 * any tab comes back as the heads the server acknowledges it with.
 *
 * `seen` sums up the server's heads: the same `seen` twice means nothing
 * arrived in between. It isn't a version of the document: Subduction's heads
 * can include ancestors of the Automerge heads, so find the document to know
 * where it is.
 *
 * Without the tab's backend (a site that brings its own Repo), the document
 * is found in `repo` and its handle's `remote-heads` are heard instead.
 */
export function watchDocument(
  source: { repo: Repo; backend?: SedimentreeBackend },
  url: AutomergeUrl,
  onChange: (seen: string) => void
): () => void {
  const summarize = (heads: readonly string[]) => [...heads].sort().join("|");
  const { documentId } = parseAutomergeUrl(url);
  if (source.backend) {
    return watchServerHeads(source.backend, documentId, ({ heads }) =>
      onChange(summarize(heads))
    );
  }
  let stop = () => {};
  let stopped = false;
  source.repo.find(url).then(
    (handle) => {
      if (stopped) return;
      const onRemote = ({ heads }: { heads: readonly string[] }) =>
        onChange(summarize(heads));
      handle.on("remote-heads", onRemote);
      stop = () => handle.off("remote-heads", onRemote);
    },
    (error) => log(`couldn't watch ${url}`, error)
  );
  return () => {
    stopped = true;
    stop();
  };
}
