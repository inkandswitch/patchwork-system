// Documents made public to Patchwork, read in the automerge worker. Keyline
// has no "anyone" principal, so "public" is one app's pair (see
// public-pair-principals.ts and pushwork's keyline/public.ts):
//
//   owner ─[read]──► reader    its archive ships: anyone can decrypt as it
//         └[relay]─► fetcher   its seed ships: anyone can fetch as it
//
// The worker connects to the sync server a second time, as the fetcher, so
// the server lets it fetch public documents' blobs, syncs keyhive as the
// fetcher, hands what that brings to a keyhive that is the reader, and
// decrypts with the reader.

import {
  idBytes,
  type SedimentreeBackend,
  type SedimentreeId,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";
import {
  SubductionBackend,
  type SubductionStorageAdapterInterface,
} from "@automerge/automerge-repo-subduction";
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket";
import { createMemorySigner } from "@automerge/subduction/slim";
import {
  Archive,
  CiphertextStore,
  ContactCard,
  DocumentId as KeyhiveDocumentId,
  Identifier,
  Power,
  Signer,
  type Keyhive,
} from "@keyhive/keyhive/slim";
import { hex, unb64, unhex } from "../keyline/bytes.js";
import { KeyhiveBackend } from "../keyline/backend.js";
import { keyhiveCodec, type Codec } from "../keyline/codec.js";
import { keylineSync, type Serial } from "../keyline/sync.js";
import {
  PATCHWORK_PUBLIC_PAIR,
  publicPairId,
  type PublicPrincipals,
} from "../public-pair-principals.js";

export type PublicReader = {
  /** The fetcher's connection, decrypted with the reader. */
  backend: SedimentreeBackend;
  network: WebSocketSubductionNetworkAdapter;
  codec: Codec;
  /** Whether the public may read `id`. */
  canRead(id: Uint8Array): Promise<boolean>;
  onChange(listener: () => void): () => void;
  /** Resolves once the first keyhive sync has finished (or failed). */
  synced: Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type PublicReaderOptions = {
  url: string;
  serverCard: Uint8Array;
  kv: SubductionStorageAdapterInterface;
  /** Where the public documents' blobs are kept: not the user's database. */
  documents: SubductionStorageAdapterInterface;
  /** Shared with every other keyhive in the worker: the wasm is not reentrant. */
  run: Serial;
  pair?: PublicPrincipals;
  log?: (...args: unknown[]) => void;
};

export async function openPublicReader({
  url,
  serverCard,
  kv,
  documents,
  run,
  pair = PATCHWORK_PUBLIC_PAIR,
  log = () => {},
}: PublicReaderOptions): Promise<PublicReader> {
  const prefix = `public/${publicPairId(pair)}`;
  const fetcherKey = `${prefix}/fetcher`;
  const readerKey = `${prefix}/reader`;
  const relayedKey = `${prefix}/relayed`;
  const seed = unhex(pair.fetcherSeed);
  const [saved, savedReader, savedRelayed] = await kv.loadMany([
    fetcherKey,
    readerKey,
    relayedKey,
  ]);
  const [fetcher, reader] = await run(async () => [
    await new Archive(saved ?? unb64(pair.fetcherArchive)).tryToKeyhive(
      CiphertextStore.newInMemory(),
      Signer.memorySignerFromBytes(seed),
      () => {}
    ),
    await openReader(pair, savedReader),
  ]);
  const card = ContactCard.fromBytes(serverCard);
  const serverKey = card.id.toBytes();
  await run(async () => {
    if (!(await fetcher.hasIndividual(card.individualId))) {
      await fetcher.receiveContactCard(card);
    }
  });

  const network = new WebSocketSubductionNetworkAdapter(url);
  const subduction = new SubductionBackend({
    signer: createMemorySigner(seed),
    storage: documents,
    network: [network],
  });

  const listeners = new Set<() => void>();
  const fetcherId = ContactCard.fromBytes(unb64(pair.fetcherCard)).id.toBytes();
  const readerId = ContactCard.fromBytes(unb64(pair.readerCard)).id.toBytes();

  // What the fetcher holds is everything the public may know: hand the
  // reader what it hasn't had yet, and keep both, and what was handed over,
  // for next time. A first visit hands over every public event the server
  // has (thousands), once.
  const relayed = new Set<string>();
  for (let i = 0; savedRelayed && i < savedRelayed.length; i += 32) {
    relayed.add(hex(savedRelayed.subarray(i, i + 32)));
  }
  const relay = async () => {
    const started = Date.now();
    const fresh = await run(async () => {
      const events = (await fetcher.eventsForAgent(
        await fetcher.getPrincipal(new Identifier(fetcherId))
      )) as Map<Uint8Array, Uint8Array>;
      const fresh = [...events].filter(([hash]) => !relayed.has(hex(hash)));
      if (fresh.length) await reader.ingestEventsBytes(fresh.map(([, e]) => e));
      return fresh.map(([hash]) => hash);
    });
    log(
      `public relay: ${fresh.length} new event(s) in ${Date.now() - started}ms`
    );
    if (!fresh.length) return;
    for (const hash of fresh) relayed.add(hex(hash));
    const [fetcherBytes, readerBytes] = await run(async () => [
      (await fetcher.toArchive()).toBytes(),
      (await reader.toArchive()).toBytes(),
    ]);
    const hashes = new Uint8Array(relayed.size * 32);
    [...relayed].forEach((h, i) => hashes.set(unhex(h), i * 32));
    await kv.saveBatch([
      [fetcherKey, fetcherBytes],
      [readerKey, readerBytes],
      [relayedKey, hashes],
    ]);
    for (const listener of listeners) listener();
  };

  const syncer = await keylineSync({
    kh: fetcher,
    run,
    node: subduction.engine,
    server: serverKey,
    card: await run(() => fetcher.getExistingContactCard()),
    onIngest: () => void relay().catch((e) => log("public relay failed", e)),
  });
  const sync = () => syncer.sync();
  network.subscribe((status) => {
    if (status === "connected")
      void sync().catch((e) => log("public keyhive sync failed", e));
  });
  // anything the fetcher had that a crash kept from the reader
  await relay();
  const synced = network
    .connected()
    .then(sync)
    .catch((e) => log("public keyhive sync failed", e));

  const codec = keyhiveCodec(reader, run);
  return {
    backend: new KeyhiveBackend({
      inner: subduction,
      codec,
      mint: () =>
        Promise.reject(new Error("the public reader can't create documents")),
      onKeyhiveChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    network,
    codec,
    canRead: (id) =>
      run(
        async () =>
          (
            await reader.accessForDoc(
              new Identifier(readerId),
              new KeyhiveDocumentId(id)
            )
          )?.atLeast(Power.read()) ?? false
      ),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    synced,
    sync,
    // the backend is closed with the routing backend it's part of
    close: () => syncer.close(),
  };
}

/**
 * The reader, who can decrypt but not sign. Keyhive takes an identity from
 * its signer's verifying key, so this one is the reader's key paired with a
 * throwaway private key: anything it signs fails to verify.
 */
async function openReader(
  p: PublicPrincipals,
  saved?: Uint8Array
): Promise<Keyhive> {
  const key = ContactCard.fromBytes(unb64(p.readerCard)).id.toBytes();
  const publicKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "Ed25519" },
    true,
    ["verify"]
  );
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const signer = await Signer.webCryptoSigner({ publicKey, privateKey });
  return new Archive(saved ?? unb64(p.readerArchive)).tryToKeyhive(
    CiphertextStore.newInMemory(),
    signer,
    () => {}
  );
}

/**
 * The user's backend, with documents only the public reader knows read
 * through it instead. Everything written goes to the user's backend: nobody
 * writes to someone else's public document.
 */
export class RoutingBackend implements SedimentreeBackend {
  constructor(
    private readonly user: SedimentreeBackend,
    private readonly publicReader: SedimentreeBackend,
    /** Whether `id` is a public document the user's keyhive doesn't know. */
    private readonly isPublic: (id: Uint8Array) => Promise<boolean>
  ) {}

  create: SedimentreeBackend["create"] = (records, options) =>
    this.user.create(records, options);
  store: SedimentreeBackend["store"] = (id, batch) =>
    this.user.store(id, batch);
  deleteLocal: SedimentreeBackend["deleteLocal"] = (id) =>
    this.user.deleteLocal(id);

  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    await Promise.all([this.user.flush(ids), this.publicReader.flush(ids)]);
  }

  open(id: SedimentreeId): SedimentreeSession {
    const session = this.isPublic(idBytes(id)).then(
      (pub) => (pub ? this.publicReader : this.user).open(id),
      () => this.user.open(id)
    );
    return {
      events: (async function* () {
        yield* (await session).events;
      })(),
      publishEphemeral: async (message) =>
        (await session).publishEphemeral(message),
      markReady: () => void session.then((s) => s.markReady()),
      close: async () => (await session).close(),
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.user.close(), this.publicReader.close()]);
  }
}
