/**
 * Creates an ephemeral intermediary Repo that sits between the host's main
 * Repo and an isolated iframe's Repo. It enforces an allowlist of document
 * URLs — only documents the user has authorized can sync to the iframe.
 *
 * Access control uses `shareConfig` on the intermediary Repo with `access()`
 * and `announce()` callbacks that gate per-document sync:
 *  - `access`: gates ALL peers (including host) by allowlist — the intermediary
 *    never holds non-allowlisted documents in memory
 *  - `announce`: only announces allowlisted documents
 *
 * The intermediary has no persistent storage (`isEphemeral: true`).
 */
import {
  Repo,
  type AutomergeUrl,
  type PeerId,
  type DocumentId,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { log } from "../log.js";

/**
 * A set of document IDs, addable by either automerge URL or raw document ID,
 * queryable by either. The allowlist and denylist are both just such sets
 * gated against by the intermediary repo's shareConfig — they differ only in
 * meaning, so they share this base. Kept as distinct named subclasses below so
 * the security-meaningful names (and their types) stay explicit at call sites.
 */
class SyncDocumentSet {
  #ids = new Set<DocumentId>();

  add(url: AutomergeUrl): void {
    const { documentId } = parseAutomergeUrl(url);
    this.#ids.add(documentId);
  }

  addDocumentId(documentId: DocumentId): void {
    this.#ids.add(documentId);
  }

  has(documentId: DocumentId): boolean {
    return this.#ids.has(documentId);
  }

  hasUrl(url: AutomergeUrl): boolean {
    const { documentId } = parseAutomergeUrl(url);
    return this.#ids.has(documentId);
  }

  get size(): number {
    return this.#ids.size;
  }
}

/**
 * Document IDs the iframe is allowed to sync. Used by the intermediary repo's
 * shareConfig to gate document access.
 */
export class SyncAllowlist extends SyncDocumentSet {}

/**
 * Document IDs that must never sync to the iframe, regardless of allowlist
 * status — the denylist takes precedence. Protects sensitive documents: the
 * account doc, module settings, tool/package source code, and branches docs.
 *
 * Unlike the allowlist, the denylist is populated asynchronously (it walks
 * documents to discover the protected set). Callers must not seed the allowlist
 * or sync anything to the iframe until it is fully populated, or a protected
 * doc could slip through before its entry lands. `setReady` records the
 * populate promise; `whenReady()` lets the boot path await it, and the
 * synchronous `isReady` flag lets the per-document sync gate fail closed
 * cheaply (see createIntermediaryRepo).
 */
export class SyncDenylist extends SyncDocumentSet {
  // A denylist with no population scheduled is trivially ready (empty but
  // complete). setReady() marks it not-ready until its populate promise lands.
  #ready: Promise<void> = Promise.resolve();
  isReady = true;

  /** Record the population promise; not ready until it resolves. */
  setReady(populated: Promise<void>): void {
    this.isReady = false;
    this.#ready = populated.then(() => {
      this.isReady = true;
    });
  }

  /** Resolves once population has completed. */
  whenReady(): Promise<void> {
    return this.#ready;
  }
}

export interface IntermediaryRepoOptions {
  /** The allowlist controlling which documents can sync to the iframe. */
  allowlist: SyncAllowlist;
  /** The host Repo to sync allowed documents from. */
  hostRepo: Repo;
  /** Optional denylist — denylisted documents are blocked regardless of allowlist. */
  denylist?: SyncDenylist;
  /**
   * Called when the iframe requests a document that's not on the allowlist
   * or denylist. If it returns true, the document is added to the allowlist.
   */
  onAccessRequest?: (documentId: DocumentId) => Promise<boolean>;
}

export interface IntermediaryRepo {
  /** Port to hand to the iframe's Repo via MessageChannelNetworkAdapter. */
  iframePort: MessagePort;
  /** Tear down the intermediary repo and close all channels. */
  shutdown(): void;
}

/**
 * Create an intermediary repo gated by the caller-supplied allowlist and
 * denylist (both already seeded before this runs).
 *
 * Two MessageChannels are created:
 *  1. hostChannel — connects intermediary ↔ host repo
 *  2. iframeChannel — connects intermediary ↔ iframe repo
 *
 * The intermediary's `shareConfig` gates document sync:
 *  - Only allowlisted documents are accepted from any peer (including the host)
 *  - Only allowlisted documents are announced to the iframe peer
 */
export function createIntermediaryRepo(
  options: IntermediaryRepoOptions
): IntermediaryRepo {
  const { allowlist, hostRepo, denylist, onAccessRequest } = options;

  const hostRepoPeerId = hostRepo.peerId;

  // Channel connecting intermediary ↔ host repo
  const hostChannel = new MessageChannel();
  const hostAdapter = new MessageChannelNetworkAdapter(hostChannel.port1, {
    useWeakRef: true,
  });

  // Channel connecting intermediary ↔ iframe repo
  const iframeChannel = new MessageChannel();
  const iframeAdapter = new MessageChannelNetworkAdapter(iframeChannel.port1, {
    useWeakRef: true,
  });

  // The one denylist gate, shared by `announce` and `access` so the two can
  // never drift apart (both must agree for the security invariant to hold).
  // Returns why a document is blocked from crossing to the iframe, or null if
  // the denylist permits it (the caller still applies the allowlist).
  //  - "not-ready": the denylist hasn't finished populating; fail closed to the
  //    iframe so a protected doc can't sync during the population window.
  //    Defense in depth — the boot path already awaits readiness before this
  //    repo exists, so on the normal path this never fires.
  //  - "denylisted": the document is in the protected set.
  // The host peer is never gated here; only iframe-bound sync is.
  const denylistBlock = (
    peerId: PeerId,
    documentId: DocumentId
  ): "not-ready" | "denylisted" | null => {
    if (peerId === hostRepoPeerId) return null;
    if (denylist && !denylist.isReady) return "not-ready";
    if (denylist?.has(documentId)) return "denylisted";
    return null;
  };

  const repo = new Repo({
    peerId: `intermediary-${crypto.randomUUID().slice(0, 8)}` as PeerId,
    network: [hostAdapter, iframeAdapter],
    isEphemeral: true,
    shareConfig: {
      announce: async (peerId: PeerId, documentId?: DocumentId) => {
        if (!documentId) return true;
        if (denylistBlock(peerId, documentId)) return false;
        return allowlist.has(documentId);
      },
      access: async (peerId: PeerId, documentId?: DocumentId) => {
        if (!documentId) return false;
        const blocked = denylistBlock(peerId, documentId);
        if (blocked === "not-ready") {
          log(`access ${documentId} BLOCKED (denylist not ready)`);
          return false;
        }
        if (blocked === "denylisted") {
          log(`access ${documentId} DENIED`);
          return false;
        }
        if (allowlist.has(documentId)) return true;

        // Not allowlisted, not denylisted — prompt the user if this
        // is an iframe request and we have a callback
        if (peerId !== hostRepoPeerId && onAccessRequest) {
          log(`access ${documentId} prompting user`);
          const approved = await onAccessRequest(documentId);
          if (approved) {
            log(`access ${documentId} APPROVED by user`);
            // Re-evaluate share config so previously-denied peers
            // pick up the new allowlist entry
            repo.shareConfigChanged();
            return true;
          }
          log(`access ${documentId} REJECTED by user`);
          return false;
        }

        if (peerId !== hostRepoPeerId) {
          log(`access ${documentId} BLOCKED`);
        }
        return false;
      },
    },
  });

  // Connect the host repo to the other end of the isolation host channel
  const isolationHostAdapter = new MessageChannelNetworkAdapter(
    hostChannel.port2,
    {
      useWeakRef: true,
    }
  );
  hostRepo.networkSubsystem.addNetworkAdapter(isolationHostAdapter);

  return {
    iframePort: iframeChannel.port2,

    shutdown() {
      isolationHostAdapter.disconnect();
      hostChannel.port1.close();
      hostChannel.port2.close();
      iframeChannel.port1.close();
      iframeChannel.port2.close();
    },
  };
}
