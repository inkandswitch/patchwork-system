// What a Repo and the sync node say to each other over a MessagePort. The
// Repo's half is a SubductionRemote (sync-remote.ts); the node's is
// sync-node.ts. Sedimentree ids travel as `SedimentreeId.toString()`, commit
// ids and heads as hex, Subduction peer ids as their bytes.

export type RecordKind = "commit" | "fragment";

export type SyncResult = {
  success: boolean;
  transportErrors?: string[];
  stats?: { commitsReceived: number; fragmentsReceived: number };
};

/** Repo → node. Those carrying an `id` get a {@link ReplyMessage}. */
export type RemoteRequest =
  | { type: "sync"; id: number; sid: string; timeoutMs: number | null }
  | { type: "peers"; id: number }
  | { type: "keyhive-peers"; id: number }
  | {
      type: "stored";
      sid: string;
      records: Array<{ kind: RecordKind; id: string }>;
    }
  | { type: "release"; sid: string }
  /**
   * Hear when a sedimentree may have new heads, without holding it: the node
   * says `changed` and sends no data, so the Repo needn't load the document.
   * It says so straight away too, with the heads it has, if it has any.
   */
  | { type: "watch"; sid: string }
  | { type: "unwatch"; sid: string }
  | { type: "ephemeral-subscribe"; sid: string }
  | { type: "ephemeral-unsubscribe"; sid: string }
  | { type: "ephemeral-publish"; sid: string; payload: Uint8Array }
  /** Start (or stop) hearing the keyhive frames the node receives. */
  | { type: "keyhive-listen" }
  | { type: "keyhive-unlisten" }
  | { type: "keyhive-send"; peer: Uint8Array; payload: Uint8Array };

export type ReplyMessage =
  | { type: "reply"; id: number; value: unknown }
  | { type: "reply"; id: number; error: string };

/** Node → Repo. */
export type NodeMessage =
  | ReplyMessage
  | { type: "state"; connecting: boolean; connected: boolean }
  | {
      type: "data";
      sid: string;
      records: Array<{ kind: RecordKind; id: string; blob: Uint8Array }>;
    }
  | { type: "heads"; sid: string; peerId: string; heads: string[] }
  /**
   * `heads` are the node's own heads for the sedimentree, which are the
   * document's automerge heads, as hex. Absent from a node that doesn't know
   * them (or predates them), in which case the Repo has to look.
   */
  | { type: "changed"; sid: string; heads?: string[] }
  | { type: "ephemeral"; sid: string; senderId: string; payload: Uint8Array }
  | { type: "keyhive-frame"; peer: Uint8Array; payload: Uint8Array }
  | { type: "keyhive-peer-disconnected"; peer: Uint8Array };

/** Tab → shared worker, on its control port, carrying the Repo's end. */
export type SyncConnectMessage = { type: "sync-connect" };
