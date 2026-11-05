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
//
// Ingesting the server's keyhive is seconds of wasm, so in a browser the
// reader runs once per origin, in its own SharedWorker (public-reader.ts), and
// every tab's Repo and the resolver's connect to it over a port. Its keyhive
// state is kept in IndexedDB, so only the first start replays it all.

import {
  stringifyAutomergeUrl,
  type DocumentId,
  type NetworkAdapterInterface,
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
/** How long after the reader last changed its archive is saved. */
const SAVE_READER_AFTER_MS = 2_000;
const READER_ARCHIVE_KEY = ["public-reader", "reader-archive"];
/** Where ARK keeps a keyhive's archives in its storage. */
const FETCHER_ARCHIVES = ["keyhive-db", "/archives/"];
const HEX = 16;
const HEX_DIGITS_PER_BYTE = 2;

type Ark = typeof import("@automerge/automerge-repo-keyhive");

export type PublicReaderNodeOptions = {
  /** The sync server's URL, which the reader connects to as the fetcher. */
  url: string;
  /** The sync server's keyhive identity. */
  syncServer: SyncServerIdentity;
  /** Whose public to read. Default: Patchwork's. */
  principals?: PublicPrincipals;
  /**
   * Where the fetcher's keyhive state and the reader's archive are kept, so a
   * start picks up from where the last one got to rather than replaying every
   * keyhive event the server has. Default: memory, for as long as this lasts.
   */
  storage?: StorageAdapterInterface;
  /** Told how far the reader has got, as it starts and after each relay. */
  onStatus?: (status: PublicReaderStatus) => void;
};

/** How far a public reader has got. */
export type PublicReaderStatus = {
  /**
   * Whether it started without saved state, so has every keyhive event the
   * server holds to catch up on rather than what's new since last time.
   */
  firstVisit: boolean;
  /** Keyhive events relayed to the reader since it started. */
  relayed: number;
};

export type PublicReader = {
  /** The reader's own Repo, signed as the fetcher. */
  repo: Repo;
  /** The fetcher's hive, which syncs keyhive with the server. */
  hive: AutomergeRepoKeyhive;
  /** The keyhive opened as the reader, which decrypts. */
  reader: Keyhive;
  /**
   * Answer a user's Repo on `control`, the other end of which is given to
   * {@link connectToPublicReader}. Returns a function that hangs up.
   */
  serve(control: MessagePort): () => void;
};

/**
 * Start a node that reads documents made public to Patchwork: it fetches and
 * decrypts a doc through the public pair when a connected user's Repo offers
 * it one (see {@link connectToPublicReader}). In a page it runs in the public
 * reader's SharedWorker (public-reader.ts), since ingesting keyhive is
 * seconds of wasm that would otherwise hold up the tab.
 */
export async function startPublicReader({
  url,
  syncServer,
  principals = PATCHWORK_PUBLIC_PAIR,
  storage = new MemoryStorage(),
  onStatus,
}: PublicReaderNodeOptions): Promise<PublicReader> {
  const ark = await import("@automerge/automerge-repo-keyhive");
  const { Repo } = await import("@automerge/automerge-repo/slim");
  const { MessageChannelNetworkAdapter } =
    await import("@automerge/automerge-repo-network-messagechannel");

  const { reader, resumed } = await openReader(ark, principals, storage);
  let relayed = 0;
  const report = () => onStatus?.({ firstVisit: !resumed, relayed });
  report();
  const queue = serial();
  const interceptor = new ReaderInterceptor(ark, reader, queue);

  // The fetcher starts from its shipped archive the first time, and from its
  // own saved state after that, which ARK compacts the shipped one into.
  if ((await storage.loadRange(FETCHER_ARCHIVES)).length === 0) {
    await storage.save(
      [...FETCHER_ARCHIVES, "fetcher"],
      fromBase64(principals.fetcherArchive)
    );
  }

  const { hive: fetcher, repo: publicRepo } =
    await ark.initializeAutomergeRepoKeyhive({
      storage,
      keyPair: await fetcherKeyPair(ark, principals.fetcherSeed),
      peerIdSuffix: `${storagePrefix}-public`,
      syncServer,
      automaticArchiveIngestion: true,
      cachingMode: "periodic",
      createRepo: (config) =>
        new Repo({ ...config, subductionBlobInterceptor: interceptor }),
      repo: {
        // Never written to: the reader can't encrypt, so nothing it holds
        // can be saved (and the user's Repo keeps what it's sent).
        storage: new MemoryStorage(),
        subductionWebsocketEndpoints: [url],
        // It holds only docs a user's Repo was offered, so it offers them
        // all back as soon as it has them.
        shareConfig: {
          announce: async () => true,
          access: async () => true,
        },
      },
    });

  // Saved a while after the reader last changed, so a start has it.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveReader = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      queue(async () => {
        const archive = (await reader.toArchive()).toBytes();
        await storage.save(READER_ARCHIVE_KEY, archive);
        log("saved the reader's archive (%d bytes)", archive.length);
      }).catch((error) => log("saving the reader's archive failed: %O", error));
    }, SAVE_READER_AFTER_MS);
  };

  // The fetcher's saved state can be ahead of the reader's: the last run may
  // have gone after the fetcher persisted an update but before the reader's
  // debounced save, or the reader's archive may be missing or rejected. Only
  // what's new is relayed, so the reader catches up from the fetcher's whole
  // history here, before any client is served.
  try {
    const caughtUp = await queue(async () => {
      const before = (await reader.stats()).totalOps;
      await reader.ingestArchive(await fetcher.keyhive.toArchive());
      return (await reader.stats()).totalOps !== before;
    });
    if (caughtUp) {
      log("the reader caught up from the fetcher's saved state");
      publicRepo.shareConfigChanged();
      saveReader();
    }
  } catch (error) {
    log("catching the reader up from the fetcher failed: %O", error);
  }

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
      relayed += events.length;
      report();
      if (grew) {
        publicRepo.shareConfigChanged();
        saveReader();
      }
    } catch (error) {
      log("relaying %d keyhive events failed: %O", events.length, error);
    }
  };
  fetcher.emitter.on("update", (event) => {
    batch.push(event.toBytes());
    flush ??= setTimeout(() => void relay(), RELAY_AFTER_MS);
  });

  const serve = (control: MessagePort) => {
    let adapter: NetworkAdapterInterface | undefined;
    let closed = false;
    const drop = () => {
      if (adapter) publicRepo.networkSubsystem.removeNetworkAdapter(adapter);
      adapter = undefined;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      drop();
      control.close();
    };
    control.addEventListener("message", ({ data }) => {
      if (closed) return;
      if (data?.type === "network" && data.port instanceof MessagePort) {
        drop();
        adapter = new MessageChannelNetworkAdapter(data.port);
        publicRepo.networkSubsystem.addNetworkAdapter(adapter);
      } else if (
        data?.type === "fetch" &&
        typeof data.documentId === "string"
      ) {
        publicRepo.findWithProgress(data.documentId as DocumentId);
      } else if (data?.type === "bye") {
        close();
      }
    });
    // A tab that goes doesn't say bye.
    control.addEventListener("close", close);
    control.start();
    control.postMessage({
      type: "reader",
      peerId: publicRepo.peerId,
    } satisfies ReaderHello);
    return close;
  };

  log("public reader started as %s", publicRepo.peerId);
  return { repo: publicRepo, hive: fetcher, reader, serve };
}

/** The public reader → a user's Repo: which peer it is. */
type ReaderHello = { type: "reader"; peerId: PeerId };

export type PublicReaderLink = {
  /** The user's Repo, which gets the reader as a peer. */
  repo: Repo;
  /** The user's hive: docs its keyhive knows are never offered to the reader. */
  hive: AutomergeRepoKeyhive;
  /** A port to a {@link PublicReader}'s `serve`. */
  control: MessagePort;
};

/** What each user's Repo knows of the reader it's connected to now. */
type Offering = {
  /** The reader's peer id, less its per-instance part. */
  reader?: string;
  fetch?: (documentId: DocumentId) => void;
};
const offerings = new WeakMap<Repo, Offering>();

/**
 * Give `repo` the public reader on `control` as a peer: it asks the reader for
 * exactly the docs its own keyhive doesn't know, and the reader fetches and
 * decrypts each through the public pair, so a find for a public doc is
 * answered over automerge sync like any other. Connecting again (to a new
 * reader, when the last one went) replaces the last connection. Returns a
 * function that hangs up.
 */
export async function connectToPublicReader({
  repo,
  hive,
  control,
}: PublicReaderLink): Promise<() => void> {
  const ark = await import("@automerge/automerge-repo-keyhive");
  const { MessageChannelNetworkAdapter } =
    await import("@automerge/automerge-repo-network-messagechannel");

  let offering = offerings.get(repo);
  if (!offering) {
    offering = {};
    offerings.set(repo, offering);
    offerUnknownDocs(ark, repo, hive, offering);
  }
  const current = offering;

  let adapter: NetworkAdapterInterface | undefined;
  let closed = false;
  const drop = () => {
    if (adapter) repo.networkSubsystem.removeNetworkAdapter(adapter);
    adapter = undefined;
  };
  // Until the reader says who it is, nothing connects: the user's Repo
  // couldn't tell it from any other peer, and would share the user's docs.
  control.addEventListener("message", ({ data }) => {
    const hello = data as ReaderHello | undefined;
    if (closed || hello?.type !== "reader" || typeof hello.peerId !== "string")
      return;
    // ARK's peer ids end in a random part per instance; the rest names the reader
    current.reader = hello.peerId.slice(0, hello.peerId.lastIndexOf("-"));
    current.fetch = (documentId) =>
      control.postMessage({ type: "fetch", documentId });
    drop();
    const { port1, port2 } = new MessageChannel();
    control.postMessage({ type: "network", port: port2 }, [port2]);
    adapter = new MessageChannelNetworkAdapter(port1);
    repo.networkSubsystem.addNetworkAdapter(adapter);
    log("connected to the public reader %s", hello.peerId);
  });
  control.start();

  return () => {
    if (closed) return;
    closed = true;
    drop();
    try {
      control.postMessage({ type: "bye" });
    } catch {
      // already gone
    }
    control.close();
  };
}

export type PublicReaderOptions = PublicReaderNodeOptions &
  Omit<PublicReaderLink, "control">;

/**
 * Start a public reader on this thread and connect `repo` to it, for where
 * there's no SharedWorker to run it in (node, tests).
 */
export async function attachPublicReader({
  repo,
  hive,
  ...options
}: PublicReaderOptions): Promise<PublicReader> {
  const node = await startPublicReader(options);
  const { port1, port2 } = new MessageChannel();
  node.serve(port2);
  await connectToPublicReader({ repo, hive, control: port1 });
  return node;
}

/**
 * Have `repo` offer the reader only the docs its own keyhive doesn't know,
 * ones made public to Patchwork or ones the user can't read at all, and have
 * the reader fetch each as it's offered: the user's Repo holds its requests
 * back while its own source is still trying the server, which can be for as
 * long as it keeps retrying. The user's own docs never reach the reader.
 * Every other peer is shared with as before.
 */
function offerUnknownDocs(
  ark: Ark,
  repo: Repo,
  hive: AutomergeRepoKeyhive,
  offering: Offering
) {
  const isReader = (peerId: PeerId) =>
    offering.reader !== undefined && peerId.startsWith(offering.reader);
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
      offering.fetch?.(documentId);
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
async function openReader(
  ark: Ark,
  p: PublicPrincipals,
  storage: StorageAdapterInterface
): Promise<{ reader: Keyhive; resumed: boolean }> {
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
  const reader = await new ark.Archive(
    fromBase64(p.readerArchive)
  ).tryToKeyhive(ark.CiphertextStore.newInMemory(), signer, () => {});
  // On top of the shipped archive, which is what has its prekey secrets.
  const saved = await storage.load(READER_ARCHIVE_KEY);
  if (saved) {
    try {
      await reader.ingestArchive(new ark.Archive(saved));
      log("the reader picked up from its saved archive");
      return { reader, resumed: true };
    } catch (error) {
      log("couldn't load the reader's saved archive: %O", error);
    }
  }
  return { reader, resumed: false };
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
