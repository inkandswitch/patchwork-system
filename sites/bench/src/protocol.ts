// The control protocol between a tab and a worker-hosted subduction node. The
// Subduction frames themselves travel on separate MessagePorts (see
// worker-link.ts); this is everything else.

export type NodeConfig = {
  /** wss:// url of the sync server, or "none" */
  server: string;
  /** The sync server's subduction peer id, so its heads can be told apart. */
  serverPeer?: string;
  /** Meet other nodes on this origin over a BroadcastChannel mesh. */
  siblings: boolean;
};

export type TabMessage =
  | { type: "config"; config: NodeConfig }
  /** Accompanied by a transferred MessagePort to accept a Subduction link on. */
  | { type: "port"; id: number }
  | { type: "offline"; offline: boolean }
  | { type: "status" };

export type NodeMessage =
  | { type: "ready"; peerId: string }
  | { type: "port-ready"; id: number }
  | { type: "port-failed"; id: number; error: string }
  | { type: "connection"; connected: boolean }
  | { type: "remote-heads"; documentId: string; heads: string[] }
  | { type: "error"; message: string };

export type ControlPort = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  start?(): void;
};
