// The automerge worker's end of a tab's port: backend calls go to the hub's
// backend and sessions stream their events back. When the tab dies (its Web
// Lock is released) everything it had open is closed.

import type {
  SedimentreeBackend,
  SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";
import { serializeError } from "./port-backend.js";
import type {
  BackendCall,
  ClientMessage,
  HubInfo,
  HubMessage,
} from "./protocol.js";

export type ServeOptions = {
  backend: SedimentreeBackend;
  peerId: string;
  /** The worker's connection to the sync server. */
  status?: {
    connected(): boolean;
    subscribe(listener: (connected: boolean) => void): () => void;
    /** The peers the worker is connected to (the sync server), hex. */
    peers(): Promise<string[]>;
    /** Cut or restore the worker's link to the sync server. */
    setOffline(offline: boolean): Promise<void>;
  };
  log?: (...args: unknown[]) => void;
  /** Called once the tab has gone and its sessions are closed. */
  onGone?: () => void;
};

/** Serve the tab on the other end of `port` until it goes away. */
export function serveClient(port: MessagePort, options: ServeOptions): void {
  const { backend, peerId, status, log = () => {}, onGone } = options;
  const sessions = new Map<number, SedimentreeSession>();
  let unsubscribeStatus: (() => void) | undefined;
  let gone = false;

  const send = (message: HubMessage) => {
    if (!gone) port.postMessage(message);
  };

  const goodbye = () => {
    if (gone) return;
    gone = true;
    log(`tab gone, closing ${sessions.size} session(s)`);
    for (const session of sessions.values()) void session.close();
    sessions.clear();
    unsubscribeStatus?.();
    port.close();
    onGone?.();
  };

  const open = (id: number, session: SedimentreeSession) => {
    sessions.set(id, session);
    void (async () => {
      try {
        for await (const event of session.events) {
          if (sessions.get(id) !== session) return;
          send({ type: "event", session: id, event });
        }
        if (sessions.get(id) === session) send({ type: "end", session: id });
      } catch (error) {
        if (sessions.get(id) === session) {
          send({ type: "end", session: id, error: serializeError(error) });
        }
      } finally {
        if (sessions.get(id) === session) sessions.delete(id);
      }
    })();
  };

  const answer = async (body: BackendCall): Promise<unknown> => {
    switch (body.op) {
      case "create":
        return backend.create(
          body.records,
          body.documentId ? { documentId: body.documentId } : undefined
        );
      case "store":
        return backend.store(body.documentId, body.records);
      case "flush":
        return backend.flush(body.ids);
      case "deleteLocal":
        return backend.deleteLocal(body.documentId);
      case "publishEphemeral": {
        const session = sessions.get(body.session);
        if (!session) throw new Error(`no session ${body.session}`);
        return session.publishEphemeral(body.message);
      }
      case "serverPeers":
        return status?.peers() ?? [];
      case "setOffline":
        if (!status) throw new Error("this worker has no sync server link");
        return status.setOffline(body.offline);
      case "info":
        return { peerId } satisfies HubInfo;
    }
  };

  port.onmessage = (event) => {
    const message = event.data as ClientMessage;
    switch (message.type) {
      case "hello":
        // the tab holds this lock while it lives, so it's ours once it's gone
        void navigator.locks.request(message.lock, goodbye);
        if (status && !unsubscribeStatus) {
          send({ type: "status", connected: status.connected() });
          unsubscribeStatus = status.subscribe((connected) =>
            send({ type: "status", connected })
          );
        }
        return;
      case "call":
        answer(message.body).then(
          (value) => send({ type: "reply", call: message.call, value }),
          (error) =>
            send({
              type: "reply",
              call: message.call,
              error: serializeError(error),
            })
        );
        return;
      case "open":
        void sessions.get(message.session)?.close();
        open(message.session, backend.open(message.documentId));
        return;
      case "markReady":
        sessions.get(message.session)?.markReady();
        return;
      case "close": {
        const session = sessions.get(message.session);
        sessions.delete(message.session);
        void session?.close();
        return;
      }
    }
  };
  port.start();
}
