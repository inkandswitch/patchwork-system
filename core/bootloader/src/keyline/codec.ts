// Encrypting and decrypting a document's blobs with keyhive. Ported from
// pushwork's keyline (pushwork#56): each blob is a keyhive block naming its
// parents, and decrypting one opens the ancestors it lists, so a document's
// blobs are decoded together.

import {
  ChangeId,
  DocumentId as KeyhiveDocumentId,
  Encrypted,
  type Keyhive,
} from "@keyhive/keyhive/slim";
import { hex, unhex } from "./bytes.js";
import type { Serial } from "./sync.js";

export interface Codec {
  /**
   * Encrypt `blob`, the commit or fragment with head `head` whose parents (a
   * commit's deps, a fragment's boundary) are `parents`, all hex.
   */
  encode(
    id: Uint8Array,
    head: string,
    parents: readonly string[],
    blob: Uint8Array
  ): Promise<Uint8Array>;
  /**
   * The plaintext of every blob in `blobs` (head, ciphertext) this keyhive can
   * open, keyed by the ciphertext it came from (the same object). Blobs it
   * can't open are left out.
   */
  decode(
    id: Uint8Array,
    blobs: readonly (readonly [head: string, blob: Uint8Array])[]
  ): Promise<Map<Uint8Array, Uint8Array>>;
  /** Whether this keyhive knows the document at all. */
  knows(id: Uint8Array): Promise<boolean>;
}

export function keyhiveCodec(kh: Keyhive, run: Serial): Codec {
  return {
    knows: (id) => run(() => kh.hasDocument(new KeyhiveDocumentId(id))),

    encode: (id, head, parents, blob) =>
      run(async () => {
        const doc = new KeyhiveDocumentId(id);
        if (!(await kh.hasDocument(doc))) {
          throw new Error(
            `cannot encrypt ${hex(id)}: keyhive does not know it`
          );
        }
        const write = async (preds: readonly string[]) =>
          (await kh.tryEncrypt(doc, changeId(head), preds.map(changeId), blob))
            .encryptedContent()
            .toBytes();
        // keyhive refuses a parent whose key it has neither written nor read;
        // leaving the parents out means a reader reaches this blob through
        // the doc's key alone
        return write(parents).catch((e) =>
          parents.length ? write([]) : Promise.reject(e)
        );
      }),

    // Every blob is decrypted with the doc's key where it can be, and the
    // ancestors it lists with the keys it carries: that opens blobs written
    // before this reader had access.
    decode: (id, blobs) =>
      run(async () => {
        const doc = new KeyhiveDocumentId(id);
        const out = new Map<Uint8Array, Uint8Array>();
        if (!(await kh.hasDocument(doc))) return out;
        // a fragment's head is stored as a loose commit too; an ancestor
        // loads as that
        const byRef = new Map<string, Uint8Array>();
        for (const [head, blob] of blobs) {
          if (!byRef.has(head)) byRef.set(head, blob);
        }
        const seen = new Set<Uint8Array>();
        for (const [head, blob] of blobs) {
          if (seen.has(blob)) continue;
          const encrypted = parseBlob(blob);
          if (!encrypted || hex(encrypted.contentRef()) !== head) continue;
          const loaded = new Map([[head, blob]]);
          const load = (ref: ChangeId) => {
            const h = hex(ref.toBytes());
            const b = byRef.get(h);
            if (!b || seen.has(b)) return undefined;
            loaded.set(h, b);
            return b;
          };
          const decryption = await kh
            .tryCausalDecrypt(doc, encrypted, load)
            .catch(() => null);
          for (const block of decryption?.complete() ?? []) {
            const b = loaded.get(hex(block.contentRef.toBytes()));
            if (!b || seen.has(b)) continue;
            seen.add(b);
            out.set(b, block.content());
          }
        }
        return out;
      }),
  };
}

function parseBlob(blob: Uint8Array): Encrypted | null {
  try {
    return Encrypted.fromBytes(blob);
  } catch {
    return null;
  }
}

const changeId = (head: string) => new ChangeId(unhex(head));
