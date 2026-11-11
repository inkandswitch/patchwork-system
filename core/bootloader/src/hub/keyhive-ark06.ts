// Keyhive for sync servers still on the previous keyhive stack (ARK 0.6,
// keyhive 0.3), which subduction.sync.inkandswitch.com runs: its keyhive
// sync messages and blob encryption are ARK 0.6's own, so they come from
// automerge-repo-keyhive 0.6 (`@ark-0.6/automerge-repo-keyhive`), as
// pushwork's ark-0.6.ts does it. Only its keyhive parts are used: its
// KeyhiveSubductionAdapter talks to this worker's subduction 0.27 engine
// through a shim, and its KeyhiveBlobInterceptor encrypts. ARK 0.6 still
// brings its automerge-repo 2 and subduction 0.16 along, but nothing here
// runs them, and this module is only loaded on a site that needs it.
//
// Keyhive 0.3 has a public "world" principal, so documents made public on
// these servers are readable by anyone's own keyhive: no public pair.
//
// subduction.sync.inkandswitch.com has since moved to keyhive_core 0.7 (the
// ARK 0.7 generation), which can't read the events keyhive 0.3 makes for a
// new document. Reading, sync and sharing still work against it; creating
// documents doesn't, and `mint` says so rather than waiting on a round the
// server never confirms.

import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction";
import bs58check from "bs58check";
import { b64, hex, unhex } from "../keyline/bytes.js";
import type { Codec } from "../keyline/codec.js";
import type { KeyhiveFrames } from "../keyline/sync.js";
import type { HubKeyhive } from "./keyhive.js";

const ARCHIVE_KEY = "keyhive-0.6/archive";
const GROUP_KEY = "keyhive-0.6/group";

export type Ark06KeyhiveOptions = {
  kv: SubductionStorageAdapterInterface;
  seed: Uint8Array;
  url: string;
  engine: KeyhiveFrames;
  log?: (...args: unknown[]) => void;
};

/** ARK 0.6 doesn't serve its card: the servers it knows ship with it. */
const KNOWN_HOSTS = ["subduction.sync.inkandswitch.com"];

export async function openArk06Keyhive({
  kv,
  seed,
  url,
  engine,
  log = () => {},
}: Ark06KeyhiveOptions): Promise<HubKeyhive> {
  if (!KNOWN_HOSTS.includes(new URL(url).host)) {
    throw new Error(
      `keyhive.ark "0.6" only knows ${KNOWN_HOSTS.join(", ")}, not ${url}`
    );
  }
  const ark = await import("@ark-0.6/automerge-repo-keyhive");
  const { PromiseQueue } =
    await import("@ark-0.6/automerge-repo-keyhive/dist/network-adapter/pending.js");
  const {
    Access,
    Archive,
    CiphertextStore,
    ContactCard,
    DocumentId: KeyhiveDocumentId,
    GroupId,
    Identifier,
    Keyhive,
    KeyhiveBlobInterceptor,
    KeyhiveStorage,
    KeyhiveSubductionAdapter,
    MemberedId,
    Signer,
    SUBDUCTION_SYNC_SERVER_CONTACT_CARD_JSON,
    peerIdFromSigner,
  } = ark;
  ark.initKeyhiveWasm();
  if (!/keyhive/.test(String(globalThis.localStorage?.debug ?? ""))) {
    ark.setKeyhiveLogLevel("silent");
  }

  const signer = Signer.memorySignerFromBytes(seed);
  const [archive, savedGroup] = await kv.loadMany([ARCHIVE_KEY, GROUP_KEY]);
  const kh = archive
    ? await new Archive(archive).tryToKeyhive(
        CiphertextStore.newInMemory(),
        signer,
        () => {}
      )
    : await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
  const card = ContactCard.fromJson(SUBDUCTION_SYNC_SERVER_CONTACT_CARD_JSON);
  if (!(await kh.hasIndividual(card.individualId)))
    await kh.receiveContactCard(card);
  const serverKey: Uint8Array = card.id.toBytes();
  const server = () => new Identifier(serverKey);
  // keyhive's wasm is not reentrant: every call into it, ours and ARK's,
  // goes through ARK's queue
  const queue = new PromiseQueue();
  const run = <T>(f: () => Promise<T>): Promise<T> => queue.run(f);
  const crypt = new KeyhiveBlobInterceptor(kh, queue);
  const me = () => new Identifier(signer.verifyingKey);

  let saving: Promise<void> | undefined;
  let dirty = false;
  const save = () => {
    dirty = true;
    saving ??= (async () => {
      while (dirty) {
        dirty = false;
        const bytes = (await run(() => kh.toArchive())).toBytes();
        await kv.saveBatch([[ARCHIVE_KEY, bytes]]);
      }
    })()
      .catch((e) => console.error("couldn't save keyhive", e))
      .finally(() => (saving = undefined));
    return saving;
  };
  const listeners = new Set<() => void>();
  const changed = () => {
    void save();
    for (const listener of listeners) listener();
  };

  // every document this device makes is in one group the server relays
  let groupKey: Uint8Array;
  if (savedGroup) {
    groupKey = savedGroup;
  } else {
    groupKey = await run(async () => {
      const g = await kh.generateGroup([]);
      const bytes = g.toBytes();
      await kh.addMember(
        server(),
        MemberedId.group(g),
        Access.fromString("relay"),
        []
      );
      return bytes;
    });
    await kv.saveBatch([[GROUP_KEY, groupKey]]);
    await save();
  }
  const group = () => new GroupId(groupKey);

  // ARK's adapter wants subduction 0.16's peer ids (objects with toBytes);
  // 0.27's are hex strings
  const node = {
    getConnectedPeerIds: async () =>
      (await engine.getConnectedPeerIds()).map((peer) => ({
        peer,
        toBytes: () => unhex(peer),
      })),
    registerFrameHandler: (
      handler: Parameters<KeyhiveFrames["registerFrameHandler"]>[0]
    ) => engine.registerFrameHandler(handler ?? null),
    sendKeyhiveMessage: (bytes: Uint8Array, peer: { peer: string } | string) =>
      engine.sendKeyhiveMessage(
        bytes,
        typeof peer === "string" ? peer : peer.peer
      ),
  };
  const serverPeer = b64(serverKey);
  const adapter = new KeyhiveSubductionAdapter({
    subduction: node as never,
    keyhive: kh,
    keyhiveStorage: new KeyhiveStorage(new Uint8Array(32), noStorage),
    keyhiveQueue: queue,
    contactCard: await run(() => kh.contactCard()),
    localPeerId: peerIdFromSigner(signer),
    remotePeerId: serverPeer as ReturnType<typeof peerIdFromSigner>,
    cachingMode: "none",
  });
  adapter.on("ingest-remote", changed);
  const sync = adapterSync(adapter, serverPeer, log);

  const docId = (id: Uint8Array) =>
    bs58check.encode(id) as Parameters<typeof crypt.transformIncoming>[0];

  const codec: Codec = {
    knows: (id) => run(() => kh.hasDocument(new KeyhiveDocumentId(id))),
    async encode(id, head, parents, blob) {
      const out = await crypt.transformOutgoing(
        docId(id),
        head,
        [...parents],
        blob
      );
      if (!out)
        throw new Error(`cannot encrypt ${hex(id)}: keyhive does not know it`);
      return out;
    },
    // a blob can need the keys others carry, so the ones that fail are
    // tried again while each pass opens more
    async decode(id, blobs) {
      const out = new Map<Uint8Array, Uint8Array>();
      let pending = [...blobs];
      while (pending.length) {
        const results = await Promise.all(
          pending.map(([head, blob]) =>
            crypt.transformIncoming(docId(id), head, blob)
          )
        );
        const failed = pending.filter(([, blob], i) => {
          const plain = results[i];
          if (plain) out.set(blob, plain);
          return !plain;
        });
        if (failed.length === pending.length) break;
        pending = failed;
      }
      return out;
    },
  };

  // own access, or the world's (anyone with the url, on keyhive 0.3)
  const access = (id: Uint8Array, level: ReturnType<typeof Access.read>) =>
    run(async () => {
      const doc = new KeyhiveDocumentId(id);
      for (const who of [me(), Identifier.publicId()]) {
        if ((await kh.bestAccessForDoc(who, doc))?.atLeast(level)) return true;
      }
      return false;
    });

  return {
    id: b64(signer.verifyingKey),
    codec,
    canRead: (id) => access(id, Access.read()),
    canWrite: (id) => access(id, Access.edit()),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The server this speaks to (subduction.sync.inkandswitch.com) has run
    // keyhive_core 0.7 since 2026-10-26 and can't read the events keyhive
    // 0.3 makes for a new document: it never confirms them, so a document
    // made here would never reach it. Existing documents still sync, and
    // access can still change.
    mint: () =>
      Promise.reject(
        new Error(
          `can't create keyhive documents on ${url}: it runs a newer keyhive ` +
            `than ARK 0.6 (keyhive.ark "0.6") speaks`
        )
      ),
    contactCard: async () =>
      new TextEncoder().encode(
        await run(async () => (await kh.contactCard()).toJson())
      ),
    async setAccess(grantee, level) {
      await run(async () => {
        let id: Uint8Array;
        if (grantee === "public") {
          id = Identifier.publicId().toBytes();
        } else {
          const who = ContactCard.fromJson(new TextDecoder().decode(grantee));
          if (!(await kh.hasIndividual(who.individualId)))
            await kh.receiveContactCard(who);
          id = who.id.toBytes();
        }
        const g = await kh.getGroup(group());
        const want = hex(id);
        const current = (await g?.members())?.find(
          (m) => hex(m.who.id.toBytes()) === want
        );
        const currentLevel = current?.can.toString().toLowerCase();
        if (currentLevel === level || (!current && level === "none")) return;
        if (current)
          await kh.revokeMember(
            new Identifier(id),
            true,
            MemberedId.group(group())
          );
        if (level !== "none") {
          await kh.addMember(
            new Identifier(id),
            MemberedId.group(group()),
            Access.fromString(level),
            []
          );
        }
      });
      changed();
      await sync();
    },
    sync,
    async close() {
      await engine.registerFrameHandler(null).catch(() => {});
      await save();
    },
  };
}

// The archive in the worker's database is the only persistence, so ARK's own
// event storage keeps nothing.
const noStorage = {
  load: async () => undefined,
  save: async () => {},
  saveBatch: async () => {},
  remove: async () => {},
  loadRange: async () => [],
  removeRange: async () => {},
};

type Peer = { syncpoint: number | null; lastKeyhiveRequestSent: number };

// ARK has no "synced" signal (as pushwork's ark-0.6.ts found). A round is done
// when the server confirms, which sets the peer's private syncpoint; rounds
// repeat while they bring in ops, as the server pages. Calls made while one
// runs share it.
function adapterSync(
  adapter: {
    syncKeyhive(force: boolean): void;
    invalidateCaches(): void;
    on(event: "ingest-remote", listener: () => void): unknown;
  },
  serverPeer: string,
  log: (...args: unknown[]) => void
): () => Promise<void> {
  const peer: Peer = (
    adapter as unknown as { peers: Map<string, Peer> }
  ).peers.get(serverPeer)!;
  let confirmed = () => {};
  let syncpoint = peer.syncpoint;
  Object.defineProperty(peer, "syncpoint", {
    get: () => syncpoint,
    set: (v) => {
      syncpoint = v;
      if (v !== null) confirmed();
    },
  });
  let ingested = false;
  adapter.on("ingest-remote", () => (ingested = true));

  const rounds = async () => {
    for (let i = 0; i < 10; i++) {
      const started = Date.now();
      ingested = false;
      adapter.invalidateCaches();
      // ARK drops a request within 1s of its last one
      peer.lastKeyhiveRequestSent = 0;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("keyhive sync timed out")),
          30_000
        );
        confirmed = () => {
          clearTimeout(timer);
          resolve();
        };
        adapter.syncKeyhive(true);
      });
      if (!ingested) return;
      // the server ignores a request within 1s of the previous one
      await new Promise((r) =>
        setTimeout(r, Math.max(0, started + 1000 - Date.now()))
      );
    }
  };
  let running: Promise<void> | undefined;
  return () =>
    (running ??= rounds()
      .catch((error) => {
        log("keyhive sync failed", error);
        throw error;
      })
      .finally(() => (running = undefined)));
}
