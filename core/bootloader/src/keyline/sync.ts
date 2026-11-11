// Keyhive sync with one subduction_keyhive server, over subduction's keyhive
// (SUK) frames. Ported from pushwork's keyline (pushwork#56).
//
// We initiate; a round is
//
//   us ── SyncRequest(found, pending) + our card ──► server
//   us ◄── SyncResponse(found ops, requested) ────── server
//   us ── SyncOps(requested) ───────────────────────► server   (if it asked for any)
//   confirmation from whichever side finishes last
//
// and we also answer what the server starts itself: a contact card request,
// or its own sync request.

import {
  ContactCard,
  Identifier,
  SignedBytes,
  type Keyhive,
} from "@keyhive/keyhive/slim";
import { equal, hex, unhex } from "./bytes.js";
import {
  decodeMessage,
  decodeSigned,
  encodeMessage,
  encodeSigned,
  type Addressed,
  type Hash,
  type Message,
} from "./wire.js";

/** Runs keyhive calls one at a time: keyhive's wasm is not reentrant. */
export type Serial = <T>(f: () => Promise<T>) => Promise<T>;

export function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (f) => {
    const run = tail.then(f);
    tail = run.catch(() => {});
    return run;
  };
}

/** The parts of a subduction engine keyhive sync talks through. */
export interface KeyhiveFrames {
  getConnectedPeerIds(): Promise<string[]>;
  registerFrameHandler(
    handler: {
      onMessage(payload: Uint8Array, peer: string): void;
      onPeerDisconnect(peer: string): void;
    } | null
  ): Promise<void>;
  sendKeyhiveMessage(payload: Uint8Array, peer: string): Promise<void>;
}

export type SyncOptions = {
  kh: Keyhive;
  run: Serial;
  node: KeyhiveFrames;
  /** The server's verifying key. */
  server: Uint8Array;
  /** Our card, sent with every request so the server never has to ask for it. */
  card: ContactCard;
  /** Called after keyhive ingests ops that changed what it knows. */
  onIngest?: () => void;
  timeoutMs?: number;
};

export type KeylineSync = {
  /**
   * Sync until a round brings in nothing new. Calls made while a sync runs
   * share it, plus one more pass after it, so none of them misses an op.
   */
  sync(): Promise<void>;
  close(): Promise<void>;
};

/** Start answering the server; `sync()` pulls and pushes keyhive ops. */
export async function keylineSync({
  kh,
  run,
  node,
  server,
  card,
  onIngest,
  timeoutMs = 30_000,
}: SyncOptions): Promise<KeylineSync> {
  const me = await run(async () => (await kh.individual()).id.toBytes());
  const serverPeer = hex(server);

  let round: { done(): void; fail(e: unknown): void } | undefined;
  let ingested = false;

  const send = (message: Message, withCard = false) =>
    run(async () => {
      const signed = (
        await kh.trySign(encodeMessage({ sender: me, target: server, message }))
      ).toBytes();
      return encodeSigned({
        signed,
        contactCard: withCard ? card.toBytes() : undefined,
      });
    }).then((bytes) => node.sendKeyhiveMessage(bytes, serverPeer));

  // the events both of us can reach, which are all the server may be sent
  const pair = () => run(() => eventsForPair(kh, me, server));

  const ingest = (events: Uint8Array[]) =>
    run(async () => {
      if (!events.length) return;
      const before = (await kh.stats()).totalOps;
      await kh.ingestEventsBytes(events);
      if ((await kh.stats()).totalOps !== before) {
        ingested = true;
        onIngest?.();
      }
    });

  async function handle({ message }: Addressed) {
    switch (message.type) {
      case "SyncResponse": {
        await ingest(message.found);
        const ours = await pair();
        const ops = message.requested.flatMap((h) => ours.get(hex(h)) ?? []);
        if (ops.length) {
          // the server confirms once it has them
          await send({
            type: "SyncOps",
            ops,
            responderTotal: message.responderTotal,
            requesterTotal: message.requesterTotal,
          });
          return;
        }
        await send({
          type: "SyncConfirmation",
          confirmerTotal: message.requesterTotal,
        });
        round?.done();
        return;
      }
      case "SyncConfirmation":
        round?.done();
        return;
      case "RequestContactCard":
        await send({ type: "MissingContactCard" }, true);
        return;
      case "SyncRequest": {
        const ours = await pair();
        const pending = await run(() => pendingHashes(kh));
        const theirs = new Set([...message.found, ...message.pending].map(hex));
        const skip = new Set([...ours.keys(), ...pending.map(hex)]);
        await send({
          type: "SyncResponse",
          found: [...ours]
            .filter(([h]) => !theirs.has(h))
            .map(([, bytes]) => bytes),
          requested: message.found.filter((h) => !skip.has(hex(h))),
          responderTotal: ours.size + pending.length,
          requesterTotal: message.found.length + message.pending.length,
        });
        return;
      }
      case "SyncOps":
        await ingest(message.ops);
        await send({
          type: "SyncConfirmation",
          confirmerTotal: message.responderTotal,
        });
        return;
      case "MissingContactCard":
      case "SyncCheck":
        // the card came with the message; our own round does the full sync
        return;
    }
  }

  // inbound frames are handled in order, one at a time
  let inbox = Promise.resolve();
  await node.registerFrameHandler({
    onMessage(payload, peer) {
      if (peer !== serverPeer) return;
      inbox = inbox
        .then(() =>
          receive(kh, run, server, payload).then((m) => m && handle(m))
        )
        .catch((e) => round?.fail(e));
    },
    onPeerDisconnect(peer) {
      if (peer === serverPeer) {
        round?.fail(new Error("the keyhive server disconnected"));
      }
    },
  });

  const once = async () => {
    if (!(await node.getConnectedPeerIds()).includes(serverPeer)) {
      throw new Error("the keyhive server is not connected");
    }
    const [ours, pending] = await Promise.all([
      pair(),
      run(() => pendingHashes(kh)),
    ]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("keyhive sync timed out")),
        timeoutMs
      );
      const finish = (e?: unknown) => {
        clearTimeout(timer);
        round = undefined;
        if (e) reject(e);
        else resolve();
      };
      round = {
        done: () => finish(),
        fail: (e) => finish(e ?? new Error("keyhive sync failed")),
      };
      send(
        { type: "SyncRequest", found: [...ours.keys()].map(unhex), pending },
        true
      ).catch(round.fail);
    });
  };

  // what a round brings in can make more events reachable, so go again
  // until it doesn't
  const rounds = async (maxRounds = 10) => {
    for (let i = 0; i < maxRounds; i++) {
      ingested = false;
      await once();
      if (!ingested) return;
    }
  };

  let running: Promise<void> | undefined;
  let again: Promise<void> | undefined;
  const sync = (): Promise<void> => {
    if (!running) {
      running = rounds().finally(() => (running = undefined));
      return running;
    }
    again ??= running
      .catch(() => {})
      .then(() => {
        again = undefined;
        return sync();
      });
    return again;
  };
  return {
    sync,
    close: () => node.registerFrameHandler(null),
  };
}

/**
 * Ask the server for its contact card over keyhive frames. The subduction
 * handshake proves the server's key, so the card is taken only if it is that
 * key's. `node` must be connected to the server as an identity that `signer`
 * signs for: the server checks that keyhive messages are signed by the
 * connection's own key.
 */
export async function fetchCardOverFrames(
  node: KeyhiveFrames,
  serverPeer: string,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
  verifyingKey: Uint8Array,
  timeoutMs = 15_000
): Promise<ContactCard> {
  const server = unhex(serverPeer);
  try {
    const card = new Promise<ContactCard>((resolve, reject) => {
      setTimeout(
        () => reject(new Error("the server sent no keyhive contact card")),
        timeoutMs
      );
      void node.registerFrameHandler({
        onMessage(payload) {
          try {
            const { contactCard, signed } = decodeSigned(payload);
            const bytes = SignedBytes.fromBytes(signed);
            if (
              !contactCard ||
              !bytes.verify() ||
              !equal(bytes.verifyingKey, server)
            ) {
              return;
            }
            const parsed = ContactCard.fromBytes(contactCard);
            if (!equal(parsed.id.toBytes(), server)) {
              reject(
                new Error("the server sent a contact card that isn't its own")
              );
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        },
        onPeerDisconnect: () => reject(new Error("the server disconnected")),
      });
    });
    const message = encodeMessage({
      sender: verifyingKey,
      target: server,
      message: { type: "RequestContactCard" },
    });
    await node.sendKeyhiveMessage(
      encodeSigned({ signed: await sign(message) }),
      serverPeer
    );
    return await card;
  } finally {
    await node.registerFrameHandler(null);
  }
}

// a verified message from the server, or nothing for one that isn't
async function receive(
  kh: Keyhive,
  run: Serial,
  server: Uint8Array,
  payload: Uint8Array
): Promise<Addressed | undefined> {
  const { contactCard, signed } = decodeSigned(payload);
  const bytes = SignedBytes.fromBytes(signed);
  if (!bytes.verify() || !equal(bytes.verifyingKey, server)) return undefined;
  const message = decodeMessage(bytes.payload());
  if (!equal(message.sender, server)) return undefined;
  if (contactCard) {
    const card = ContactCard.fromBytes(contactCard);
    await run(async () => {
      if (!(await kh.hasIndividual(card.individualId))) {
        await kh.receiveContactCard(card);
      }
    });
  }
  return message;
}

/** The events `a` and `b` can both reach, by hash (hex). */
export async function eventsForPair(
  kh: Keyhive,
  a: Uint8Array,
  b: Uint8Array
): Promise<Map<string, Uint8Array>> {
  const [ours, theirs] = [await eventsFor(kh, a), await eventsFor(kh, b)];
  return new Map([...ours].filter(([h]) => theirs.has(h)));
}

// what keyhive sends `id`: its membership, prekey and CGKA events, and its
// own prekey ops
async function eventsFor(
  kh: Keyhive,
  id: Uint8Array
): Promise<Map<string, Uint8Array>> {
  const principal = await kh.getPrincipal(new Identifier(id));
  const out = new Map<string, Uint8Array>();
  for (const events of [
    await kh.eventsForAgent(principal),
    await principal.keyOps(),
  ]) {
    for (const [hash, bytes] of events as Map<Hash, Uint8Array>) {
      out.set(hex(hash), bytes);
    }
  }
  return out;
}

const pendingHashes = async (kh: Keyhive): Promise<Hash[]> => [
  ...((await kh.pendingEventHashes()) as Set<Hash>),
];
