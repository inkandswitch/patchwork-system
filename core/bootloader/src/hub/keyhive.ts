// Keyhive in the automerge worker, used directly (no automerge-repo-keyhive),
// as pushwork's keyline does (pushwork#56): membership and encryption from
// @keyhive/keyhive, and keyhive sync with the server over subduction's
// keyhive frames. Only relay/read/edit membership for now; no BeeKEM.
//
// The worker is the only holder of this device's keyhive. Its state is one
// archive in the worker's database, written back after every change.

import {
  recordHead,
  sedimentreeId,
  type RecordBatch,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree";
import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction";
import {
  Archive,
  ChangeId,
  CiphertextStore,
  ContactCard,
  DocumentId as KeyhiveDocumentId,
  GroupId,
  Identifier,
  Keyhive,
  MemberedId,
  Power,
  Signer,
} from "@keyhive/keyhive/slim";
import { b64, hex, unb64, unhex } from "../keyline/bytes.js";
import { PATCHWORK_PUBLIC_PAIR } from "../public-pair-principals.js";
import { keyhiveCodec, type Codec } from "../keyline/codec.js";
import {
  keylineSync,
  serial,
  type KeyhiveFrames,
  type Serial,
} from "../keyline/sync.js";
import type { HubHive } from "./serve.js";

const ARCHIVE_KEY = "keyhive/archive";
const GROUP_KEY = "keyhive/group";
const cardKey = (url: string) =>
  `keyhive/server-card/${encodeURIComponent(url)}`;

export type AccessLevel = "relay" | "read" | "edit" | "admin" | "none";

/** A device's keyhive, whichever generation the sync server speaks. */
export type HubKeyhive = HubHive & {
  codec: Codec;
  /** A new keyhive document for records, once the server knows it. */
  mint(records: RecordBatch): Promise<SedimentreeId>;
  /** This device's contact card, for someone to grant it access. */
  contactCard(): Promise<Uint8Array>;
  /**
   * Give the holder of `card` (or the public, as this keyhive means it)
   * `level` on every document this device makes (its group), replacing what
   * it had; "none" revokes it.
   */
  setAccess(card: Uint8Array | "public", level: AccessLevel): Promise<void>;
  /** Sync keyhive with the server now (it is connected again, say). */
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type HubKeyhiveOptions = {
  /** The worker's own key-value store (not the backend's). */
  kv: SubductionStorageAdapterInterface;
  /** The seed the worker's subduction signer is made from: one identity for both. */
  seed: Uint8Array;
  /** The sync server's URL (ws:// or wss://). */
  url: string;
  /** The backend's subduction engine, connected (or connecting) to the server. */
  engine: KeyhiveFrames;
  /** Shared with every other keyhive in the worker: the wasm is not reentrant. */
  run?: Serial;
  log?: (...args: unknown[]) => void;
};

export async function openHubKeyhive({
  kv,
  seed,
  url,
  engine,
  run = serial(),
  log = () => {},
}: HubKeyhiveOptions): Promise<
  HubKeyhive & {
    /** The sync server's keyhive contact card. */
    serverCard: Uint8Array;
  }
> {
  const signer = Signer.memorySignerFromBytes(seed);
  // keyhive takes ids by value (wasm-bindgen moves them), so each call gets a
  // fresh one made from bytes
  const me = () => new Identifier(signer.verifyingKey);
  const [archive, savedGroup] = await kv.loadMany([ARCHIVE_KEY, GROUP_KEY]);
  const kh = archive
    ? await new Archive(archive).tryToKeyhive(
        CiphertextStore.newInMemory(),
        signer,
        () => {}
      )
    : await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});

  const serverCard = await loadServerCard(kv, url, log);
  if (!(await kh.hasIndividual(serverCard.individualId))) {
    await kh.receiveContactCard(serverCard);
  }
  const serverKey = serverCard.id.toBytes();
  const server = () => new Identifier(serverKey);

  // writes are coalesced: one archive write after a burst of changes
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

  // Every document this device makes is in one group, which the server
  // relays: that's what lets it store and serve the document's blobs.
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
        Power.fromString("relay")
      );
      return bytes;
    });
    await kv.saveBatch([[GROUP_KEY, groupKey]]);
    await save();
  }
  const group = () => new GroupId(groupKey);

  const card = await run(() => kh.contactCard());
  await save();
  const syncer = await keylineSync({
    kh,
    run,
    node: engine,
    server: serverKey,
    card,
    onIngest: changed,
  });
  const sync = () =>
    syncer.sync().catch((error) => {
      log("keyhive sync failed", error);
      throw error;
    });

  const access = async (id: Uint8Array, level: Power) =>
    run(
      async () =>
        (await kh.accessForDoc(me(), new KeyhiveDocumentId(id)))?.atLeast(
          level
        ) ?? false
    );

  async function setAccess(
    grantee: Uint8Array | "public",
    level: AccessLevel
  ): Promise<void> {
    if (grantee === "public") {
      // keyline's public is patchwork's pair: anyone reads as its reader,
      // and fetches as its fetcher; it goes no further than read
      if (level === "edit" || level === "admin") {
        throw new Error(`public access goes up to read, not ${level}`);
      }
      await setAccess(
        unb64(PATCHWORK_PUBLIC_PAIR.fetcherCard),
        level === "none" ? "none" : "relay"
      );
      await setAccess(
        unb64(PATCHWORK_PUBLIC_PAIR.readerCard),
        level === "read" ? "read" : "none"
      );
      return;
    }
    const card = ContactCard.fromBytes(grantee);
    await run(async () => {
      if (!(await kh.hasIndividual(card.individualId)))
        await kh.receiveContactCard(card);
      const who = card.id.toBytes();
      const want = hex(who);
      const g = await kh.getGroup(group());
      const current = (await g?.members())?.find(
        (m) => hex(m.who.toBytes()) === want
      );
      const currentLevel = current?.can.toString().toLowerCase();
      if (currentLevel === level || (!current && level === "none")) return;
      if (current)
        await kh.revokeMember(
          new Identifier(who),
          true,
          MemberedId.group(group())
        );
      if (level !== "none") {
        await kh.addMember(
          new Identifier(who),
          MemberedId.group(group()),
          Power.fromString(level)
        );
      }
    });
    changed();
    await sync();
  }

  return {
    id: b64(signer.verifyingKey),
    serverCard: serverCard.toBytes(),
    codec: keyhiveCodec(kh, run),
    canRead: (id) => access(id, Power.read()),
    canWrite: (id) => access(id, Power.edit()),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async mint(records) {
      const heads = records.map((r) => new ChangeId(unhex(recordHead(r))));
      const fresh = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const doc = await run(() =>
        kh.generateDocument(
          [group().toIdentifier()],
          heads[0] ?? fresh,
          heads.slice(1)
        )
      );
      changed();
      // the server refuses blobs for a document it hasn't heard of
      await sync();
      log("minted keyhive document", hex(doc.toBytes()));
      return sedimentreeId(doc.toBytes());
    },

    contactCard: () => run(async () => (await kh.contactCard()).toBytes()),

    setAccess,
    sync,

    async close() {
      await syncer.close();
      await save();
    },
  };
}

/**
 * The sync server's keyhive contact card, which it serves at
 * `/keyhive/contact-card` on the same host. Fetched on every start, so a
 * redeployed server's new card is picked up, and kept for a start without a
 * network. Trusted on first use: it is only as trustworthy as the connection
 * it came over.
 */
async function loadServerCard(
  kv: SubductionStorageAdapterInterface,
  url: string,
  log: (...args: unknown[]) => void
): Promise<ContactCard> {
  const key = cardKey(url);
  try {
    // "wss://host" → "https://host", "ws://host" → "http://host"
    const cardUrl = new URL(
      "/keyhive/contact-card",
      url.replace(/^ws/, "http")
    );
    const response = await fetch(cardUrl);
    if (!response.ok)
      throw new Error(`GET ${cardUrl} responded with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const card = ContactCard.fromBytes(bytes);
    await kv.saveBatch([[key, bytes]]);
    return card;
  } catch (error) {
    const [saved] = await kv.loadMany([key]);
    if (!saved)
      throw new Error(`no keyhive contact card for ${url}`, { cause: error });
    log(
      `using the saved keyhive contact card for ${url}; fetching it failed`,
      error
    );
    return ContactCard.fromBytes(saved);
  }
}
