// Reading documents made public with Patchwork's public pair.
//
// Keyhive 0.6 has no public "world" user. A repo is made public to an app by
// granting two principals whose secrets the app ships in the clear:
//
//   reader   read. Its archive holds its prekey secrets but no signing key,
//            so anyone can decrypt as it and nobody can sign as it.
//   fetcher  relay. Its signing seed is shipped, so anyone can connect to
//            the sync server as it and pull the ciphertext.
//
// The user's own Repo connects as the user, who isn't a member of these docs,
// so the server never sends it their blobs. Instead a second Repo connects as
// the fetcher: it syncs keyhive as the fetcher, hands every keyhive event it
// gets to a keyhive opened as the reader, and decrypts blobs with that. It sits
// beside the user's Repo as a peer on a MessageChannel, and the user's Repo
// asks it for exactly the docs the user's keyhive doesn't know, so a find for
// a public doc is answered over automerge sync like any other.
//
// The reader Repo never writes: anything the user changes in a public doc
// stays local. Pushwork makes repos public this way (`--public-access read`).

import {
  stringifyAutomergeUrl,
  type DocumentId,
  type PeerId,
  type Repo,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim";
import type {
  AutomergeRepoKeyhive,
  Keyhive,
  SyncServerIdentity,
} from "@automerge/automerge-repo-keyhive";
import debug from "debug";

import {
  PATCHWORK_PUBLIC_PAIR,
  type PublicPrincipals,
} from "./public-pair-principals.js";
import { storagePrefix } from "./storage.js";

export { PATCHWORK_PUBLIC_PAIR, type PublicPrincipals };

const log = debug("patchwork:public-pair");

/** How long the fetcher's keyhive events gather before the reader ingests them. */
const RELAY_AFTER_MS = 100;
const HEX = 16;
const HEX_DIGITS_PER_BYTE = 2;

type Ark = typeof import("@automerge/automerge-repo-keyhive");

export type PublicReaderOptions = {
  /** The user's Repo, which gets the reader as a peer. */
  repo: Repo;
  /** The user's hive: docs its keyhive knows are never offered to the reader. */
  hive: AutomergeRepoKeyhive;
  /** The sync server's URL, which the reader connects to as the fetcher. */
  url: string;
  /** The sync server's keyhive identity, as the user's hive was given it. */
  syncServer: SyncServerIdentity;
  /** Whose public to read. Default: Patchwork's. */
  principals?: PublicPrincipals;
};

export type PublicReader = {
  /** The reader's own Repo, signed as the fetcher. */
  repo: Repo;
  /** The fetcher's hive, which syncs keyhive with the server. */
  hive: AutomergeRepoKeyhive;
  /** The keyhive opened as the reader, which decrypts. */
  reader: Keyhive;
};

/**
 * Give `repo` a peer that reads documents made public to Patchwork: the user's
 * Repo asks it for any doc the user's keyhive doesn't know, and it fetches and
 * decrypts that doc through the public pair.
 */
export async function attachPublicReader({
  repo,
  hive,
  url,
  syncServer,
  principals = PATCHWORK_PUBLIC_PAIR,
}: PublicReaderOptions): Promise<PublicReader> {
  const ark = await import("@automerge/automerge-repo-keyhive");
  const { Repo } = await import("@automerge/automerge-repo/slim");
  const { MessageChannelNetworkAdapter } =
    await import("@automerge/automerge-repo-network-messagechannel");

  const reader = await openReader(ark, principals);
  const queue = serial();
  const interceptor = new ReaderInterceptor(ark, reader, queue);

  // The fetcher's keyhive state lives only as long as this Repo: every start
  // begins from its archive and syncs what it relays from the server again.
  const keyhiveStorage = new MemoryStorage();
  await keyhiveStorage.save(
    ["keyhive-db", "/archives/", "fetcher"],
    fromBase64(principals.fetcherArchive)
  );

  const channel = new MessageChannel();
  const { hive: fetcher, repo: publicRepo } =
    await ark.initializeAutomergeRepoKeyhive({
      storage: keyhiveStorage,
      keyPair: await fetcherKeyPair(ark, principals.fetcherSeed),
      peerIdSuffix: `${storagePrefix}-public`,
      syncServer,
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      createRepo: (config) =>
        new Repo({ ...config, subductionBlobInterceptor: interceptor }),
      repo: {
        storage: new MemoryStorage(),
        network: [new MessageChannelNetworkAdapter(channel.port2)],
        subductionWebsocketEndpoints: [url],
        // It holds only docs the user's Repo was offered, so it offers
        // them all back as soon as it has them.
        shareConfig: {
          announce: async () => true,
          access: async () => true,
        },
      },
    });

  // Everything the fetcher learns goes to the reader, which is what makes a
  // doc's keys reachable to it. A sync brings thousands of events, so they're
  // ingested in batches, off the event that brought them. Blobs that arrived
  // before their keys are retried once a batch has changed the reader.
  let batch: Uint8Array[] = [];
  let flush: ReturnType<typeof setTimeout> | undefined;
  const relay = async () => {
    flush = undefined;
    const events = batch;
    batch = [];
    try {
      const grew = await queue(async () => {
        const before = (await reader.stats()).totalOps;
        await reader.ingestEventsBytes(events);
        return (await reader.stats()).totalOps !== before;
      });
      log(
        "relayed %d keyhive events%s",
        events.length,
        grew ? "" : ", none new"
      );
      if (grew) publicRepo.shareConfigChanged();
    } catch (error) {
      log("relaying %d keyhive events failed: %O", events.length, error);
    }
  };
  fetcher.emitter.on("update", (event) => {
    batch.push(event.toBytes());
    flush ??= setTimeout(() => void relay(), RELAY_AFTER_MS);
  });

  // The user's Repo holds its requests back while its own source is still
  // trying the server, which can be for as long as it keeps retrying. So a
  // doc it offers is fetched straight away, and offered back once it's here.
  offerUnknownDocs(ark, repo, hive, publicRepo.peerId, (documentId) =>
    publicRepo.findWithProgress(documentId)
  );
  repo.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(channel.port1)
  );
  log("public reader attached as %s", publicRepo.peerId);
  return { repo: publicRepo, hive: fetcher, reader };
}

/**
 * Have `repo` offer the reader (`readerPeer`) only the docs its own keyhive
 * doesn't know, ones made public to Patchwork or ones the user can't read at
 * all, and `fetch` each as it's offered. The user's own docs never reach the
 * reader. Every other peer is shared with as before.
 */
function offerUnknownDocs(
  ark: Ark,
  repo: Repo,
  hive: AutomergeRepoKeyhive,
  readerPeer: PeerId,
  fetch: (documentId: DocumentId) => void
) {
  // ARK's peer ids end in a random part per instance; the rest names the reader
  const prefix = readerPeer.slice(0, readerPeer.lastIndexOf("-"));
  const isReader = (peerId: PeerId) => peerId.startsWith(prefix);
  const offered = async (documentId?: DocumentId) => {
    if (!documentId) return false;
    const url = stringifyAutomergeUrl({ documentId });
    if (ark.isUnprotectedDoc(url)) return false;
    try {
      const known = await hive.keyhive.hasDocument(
        ark.docIdFromAutomergeUrl(url)
      );
      if (known) return false;
      log("offering %s to the public reader", documentId);
      fetch(documentId);
      return true;
    } catch (error) {
      log("couldn't tell whether keyhive knows %s: %O", documentId, error);
      return false;
    }
  };
  // The Repo's synchronizer holds this object, so it is changed in place.
  const config = repo.shareConfig;
  const { announce, access } = config;
  config.announce = (peerId, documentId) =>
    isReader(peerId) ? offered(documentId) : announce(peerId, documentId);
  config.access = (peerId, documentId) =>
    isReader(peerId) ? offered(documentId) : access(peerId, documentId);
}

/**
 * The reader, who can decrypt but not sign. Keyhive takes an identity from its
 * signer's verifying key, so this is the reader's key paired with a throwaway
 * private key: anything it signs fails to verify.
 */
async function openReader(ark: Ark, p: PublicPrincipals): Promise<Keyhive> {
  const key = ark.ContactCard.fromBytes(fromBase64(p.readerCard)).id.toBytes();
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "Ed25519" },
    true,
    ["verify"]
  );
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const signer = await ark.Signer.webCryptoSigner({ publicKey, privateKey });
  return new ark.Archive(fromBase64(p.readerArchive)).tryToKeyhive(
    ark.CiphertextStore.newInMemory(),
    signer,
    () => {}
  );
}

/** The fetcher's Ed25519 key pair, from its seed, extractable as ARK needs. */
async function fetcherKeyPair(
  ark: Ark,
  seedHex: string
): Promise<CryptoKeyPair> {
  const seed = fromHex(seedHex);
  const x = toBase64Url(ark.Signer.memorySignerFromBytes(seed).verifyingKey);
  const jwk = { kty: "OKP", crv: "Ed25519", x };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk, "Ed25519", true, [
      "verify",
    ]),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: toBase64Url(seed) },
      "Ed25519",
      true,
      ["sign"]
    ),
  };
}

/**
 * Decrypts with the reader's keyhive, the way ARK's KeyhiveBlobInterceptor
 * does with the user's: each blob is a keyhive block whose content ref is its
 * commit id, carrying its parents' keys, so a cold load decrypts the ancestors
 * it lists too. Never encrypts: the reader can't write.
 */
class ReaderInterceptor {
  // commits already handed to the Repo, whose ancestors needn't be read again
  #delivered = new Set<string>();

  constructor(
    private ark: Ark,
    private reader: Keyhive,
    private queue: Serial
  ) {}

  async transformOutgoing(): Promise<Uint8Array | null> {
    return null;
  }

  transformIncoming(
    documentId: DocumentId,
    commitId: string,
    blob: Uint8Array,
    loadBlob?: (commitIdHex: string) => Promise<Uint8Array | null>
  ): Promise<Uint8Array | null> {
    const url = stringifyAutomergeUrl({ documentId });
    if (this.ark.isUnprotectedDoc(url)) return Promise.resolve(blob);
    return this.queue(async () => {
      const docId = this.ark.docIdFromAutomergeUrl(url);
      // its keys haven't been relayed yet: left pending, and retried then
      if (!(await this.reader.hasDocument(docId))) {
        log("no keys for %s yet", documentId);
        return null;
      }
      let encrypted;
      try {
        encrypted = this.ark.Encrypted.fromBytes(blob);
      } catch {
        return null;
      }
      const own = toHex(encrypted.contentRef());
      if (commitId && commitId !== own) return null;
      const load = async (ref: { toBytes(): Uint8Array }) => {
        const hex = toHex(ref.toBytes());
        if (this.#delivered.has(hex) || !loadBlob) return undefined;
        return (await loadBlob(hex)) ?? undefined;
      };
      let decryption;
      try {
        decryption = await this.reader.tryCausalDecrypt(docId, encrypted, load);
      } catch (error) {
        log("couldn't decrypt %s of %s: %O", own, documentId, error);
        return null;
      }
      const fresh = decryption
        .complete()
        .map((block) => ({ block, hex: toHex(block.contentRef.toBytes()) }))
        .filter(({ hex }) => hex === own || !this.#delivered.has(hex));
      fresh.forEach(({ hex }) => this.#delivered.add(hex));
      return concat(fresh.map(({ block }) => block.content()));
    });
  }
}

/** Runs keyhive calls one at a time: keyhive's wasm isn't reentrant. */
type Serial = <T>(f: () => Promise<T>) => Promise<T>;

function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (f) => {
    const previous = tail;
    const run = (async () => {
      try {
        await previous;
      } catch {
        // an earlier call's failure is its own caller's to handle
      }
      return f();
    })();
    tail = run;
    return run;
  };
}

/** Storage that lasts as long as the page. */
class MemoryStorage implements StorageAdapterInterface {
  #data = new Map<string, { key: StorageKey; data: Uint8Array }>();

  async load(key: StorageKey) {
    return this.#data.get(JSON.stringify(key))?.data;
  }
  async save(key: StorageKey, data: Uint8Array) {
    this.#data.set(JSON.stringify(key), { key, data });
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    entries.forEach(([key, data]) =>
      this.#data.set(JSON.stringify(key), { key, data })
    );
  }
  async remove(key: StorageKey) {
    this.#data.delete(JSON.stringify(key));
  }
  async loadRange(prefix: StorageKey) {
    return [...this.#data.values()].filter(({ key }) =>
      startsWith(key, prefix)
    );
  }
  async removeRange(prefix: StorageKey) {
    [...this.#data]
      .filter(([, { key }]) => startsWith(key, prefix))
      .forEach(([id]) => this.#data.delete(id));
  }
}

const startsWith = (key: StorageKey, prefix: StorageKey) =>
  prefix.every((part, i) => key[i] === part);

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  }, 0);
  return out;
}

const fromBase64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .split("=")[0];
const fromHex = (s: string) =>
  Uint8Array.from({ length: s.length / HEX_DIGITS_PER_BYTE }, (_, i) =>
    parseInt(
      s.slice(i * HEX_DIGITS_PER_BYTE, (i + 1) * HEX_DIGITS_PER_BYTE),
      HEX
    )
  );
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) =>
    b.toString(HEX).padStart(HEX_DIGITS_PER_BYTE, "0")
  ).join("");
