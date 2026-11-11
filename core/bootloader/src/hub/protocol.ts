// What a tab and the automerge worker say to each other over a MessagePort.
// The worker holds the one sedimentree backend for the origin (its IndexedDB,
// its socket to the sync server, its keyhive); each tab's Repo runs on a
// PortBackend that forwards to it. See docs/bootloader.html#hub.

import type {
  BackendOperation,
  EphemeralEnvelope,
  RecordBatch,
  SedimentreeEvent,
  SedimentreeId,
} from "@automerge/automerge-repo/sedimentree";

export type BackendCall =
  | { op: "create"; records: RecordBatch; documentId?: SedimentreeId }
  | { op: "store"; documentId: SedimentreeId; records: RecordBatch }
  | { op: "flush"; ids?: SedimentreeId[] }
  | { op: "deleteLocal"; documentId: SedimentreeId }
  | { op: "publishEphemeral"; session: number; message: EphemeralEnvelope }
  | { op: "hive"; method: "canRead" | "canWrite"; url: string }
  | { op: "info" }
  /** The peers the worker is connected to: the sync server's id, hex. */
  | { op: "serverPeers" }
  /** Cut or restore the worker's link to the sync server (bench, dev). */
  | { op: "setOffline"; offline: boolean };

/** Tab → worker. */
export type ClientMessage =
  | {
      type: "hello";
      /** A Web Lock the tab holds for as long as it lives. */
      lock: string;
    }
  | { type: "call"; call: number; body: BackendCall }
  | {
      type: "open";
      session: number;
      documentId: SedimentreeId;
    }
  | { type: "markReady"; session: number }
  | { type: "close"; session: number };

export type SerializedError = {
  message: string;
  name?: string;
  operation?: BackendOperation;
  code?: string;
  retryable?: boolean;
};

/** Worker → tab. */
export type HubMessage =
  | { type: "reply"; call: number; value?: unknown; error?: SerializedError }
  | { type: "event"; session: number; event: SedimentreeEvent }
  | { type: "end"; session: number; error?: SerializedError }
  /** Keyhive learned something that may change what this device can open. */
  | { type: "hive-change" }
  /** Whether the worker is connected to the sync server; sent on every change. */
  | { type: "status"; connected: boolean };

/** Who the worker is. */
export type HubInfo = {
  /** The hex verifying key it signs as, towards the sync server. */
  peerId: string;
  /** Its keyhive identity (base64), on a keyhive site. */
  hive: { id: string } | null;
};
