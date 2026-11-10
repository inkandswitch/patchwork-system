// Stamps every change made through a DocHandle with the package version that
// made it (`pw:<key>` in the change message), and records each key's package
// root once per doc under `@patchwork.writers`, in a change of its own.
import * as A from "@automerge/automerge/slim";
import { DocHandle } from "@automerge/automerge-repo/slim";
import { findWriter, MAX_KEY_LENGTH, writerKey, type WriterContext } from "./writer.js";

/**
 * Who is writing, as far as this tab knows. `id` is the change author, 16 hex
 * characters (the first 8 bytes of `device`); `device` is this device's
 * verifying key in hex; `contact` the account's contact card url, once known.
 * None of it is verified: it's what this tab says about itself.
 */
export type Author = { id: string; device: string; contact?: string };

export type ProvenanceOptions = WriterContext & {
  /** Where the stack comes from; tests choose it. Defaults to a fresh Error's stack, 50 frames deep. */
  stack?: () => string | undefined;
  /** Who is writing; each doc's changes carry `id` as their author, and `@patchwork.authors[id]` says the rest. */
  author?: () => Author | undefined;
};

export const WRITERS = "writers";
export const AUTHORS = "authors";
const PATCHWORK = "@patchwork";

let warned = false;
function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn("patchwork provenance: a change went unstamped or unrecorded", error);
}

/** The caller's message, then `pw:<key>` on its own line, and where the write came from if known. */
export function composeMessage(message: string | undefined, key: string, at?: string): string {
  const line = at ? `pw:${key} ${at}` : `pw:${key}`;
  return message ? `${message}\n${line}` : line;
}

function captureStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

type AnyHandle = DocHandle<any>;
type Proto = {
  change: AnyHandle["change"];
  changeAt: AnyHandle["changeAt"];
  sub: AnyHandle["sub"];
};

/** Marks the shared prototype, so a second copy of this module can't wrap it again. */
const INSTALLED = Symbol.for("@inkandswitch/patchwork/provenance");

/**
 * Wraps `DocHandle.prototype.change`, `changeAt` and `sub` once for the tab.
 * Returns an uninstall that puts the originals back.
 */
export function installProvenance(options: ProvenanceOptions): () => void {
  const proto = DocHandle.prototype as unknown as Proto & { [INSTALLED]?: true };
  if (proto[INSTALLED]) throw new Error("provenance already installed");
  proto[INSTALLED] = true;

  const original: Proto = { change: proto.change, changeAt: proto.changeAt, sub: proto.sub };
  const stack = options.stack ?? captureStack;
  /** A sub-handle's root handle. Repo hands out only roots, so every sub comes from `sub`. */
  const roots = new WeakMap<AnyHandle, AnyHandle>();
  /** The key a writer uses in a doc, once collisions are settled: `documentId \n root` → key. */
  const keys = new Map<string, string>();

  /** Backends whose changes already carry this tab's author. */
  const authored = new WeakSet<object>();
  const authorFor = (handle: AnyHandle): Author | undefined => {
    const author = options.author?.();
    if (!author || !/^[0-9a-f]{16}$/.test(author.id)) return undefined;
    const backend = A.getBackend(handle.fullDoc() as A.Doc<unknown>) as { setAuthor?(id: string): void };
    if (!authored.has(backend)) {
      backend.setAuthor?.(author.id);
      authored.add(backend);
    }
    return author;
  };

  const writer = () => {
    const text = stack();
    return typeof text === "string" && text ? findWriter(text, options) : null;
  };

  const keyFor = (handle: AnyHandle, root: string, short: string): string => {
    const cacheKey = `${handle.documentId}\n${root}`;
    const cached = keys.get(cacheKey);
    if (cached) return cached;
    const recorded = (handle.fullDoc() as any)?.[PATCHWORK]?.[WRITERS];
    const takenByOther = (key: string) => {
      if (!isPlainObject(recorded)) return false;
      const record = recorded[key];
      return isPlainObject(record) && record.url !== root;
    };
    let key = short;
    while (key.length < MAX_KEY_LENGTH && takenByOther(key)) {
      key = writerKey(root, key.length + 1);
    }
    keys.set(cacheKey, key);
    return key;
  };

  const rootOf = (handle: AnyHandle): AnyHandle | undefined => {
    const root = roots.get(handle);
    if (root) return root;
    return handle.path.length === 0 && !handle.range ? handle : undefined;
  };

  /** Whether `doc[@patchwork][field]` lacks `key`, or `null` when it can't hold a record at all. */
  const lacks = (meta: unknown, field: string, key: string): boolean | null => {
    if (meta === undefined) return true;
    if (!isPlainObject(meta)) return null;
    const records = meta[field];
    if (records === undefined) return true;
    if (!isPlainObject(records)) return null;
    return !Object.hasOwn(records, key);
  };

  const record = (handle: AnyHandle, key: string, url: string, author: Author | undefined) => {
    const meta = (handle.fullDoc() as any)?.[PATCHWORK];
    const writer = lacks(meta, WRITERS, key) === true;
    let person = false;
    if (author) {
      const missing = lacks(meta, AUTHORS, author.id);
      // Again once the contact card is known, if it wasn't the first time.
      person = missing === true || (missing === false && !!author.contact && !meta[AUTHORS][author.id]?.contact);
    }
    if (!writer && !person) return;
    const root = rootOf(handle);
    if (!root) return;
    const put = (doc: any, field: string, id: string, value: Record<string, string>) => {
      if (doc[PATCHWORK] === undefined) doc[PATCHWORK] = {};
      if (doc[PATCHWORK][field] === undefined) doc[PATCHWORK][field] = {};
      doc[PATCHWORK][field][id] = value;
    };
    original.change.call(
      root,
      (doc: any) => {
        if (writer) put(doc, WRITERS, key, { url });
        if (person && author) {
          put(doc, AUTHORS, author.id, {
            device: author.device,
            ...(author.contact ? { contact: author.contact } : {}),
          });
        }
      },
      { message: composeMessage(undefined, key) },
    );
  };

  /** Runs `run` with the stamped message, then records the writer if the change landed. */
  const stamped = <R>(
    handle: AnyHandle,
    opts: A.ChangeOptions<any> | undefined,
    run: (opts: A.ChangeOptions<any> | undefined) => R,
  ): R => {
    // Provenance never stops a write: any failure here leaves it unstamped,
    // or (after it landed) unrecorded.
    let found: { root: string; key: string; at?: string } | null = null;
    let author: Author | undefined;
    let before = "";
    try {
      if (!handle.isReadOnly()) {
        const writer_ = writer();
        if (writer_) {
          found = { root: writer_.root, key: keyFor(handle, writer_.root, writer_.key), at: writer_.at };
          before = A.getHeads(handle.fullDoc()).join();
        }
      }
    } catch (error) {
      warnOnce(error);
      found = null;
    }
    if (!found) return run(opts);
    try {
      author = authorFor(handle);
    } catch (error) {
      warnOnce(error);
    }
    const result = run({ ...opts, message: composeMessage(opts?.message, found.key, found.at) });
    try {
      if (A.getHeads(handle.fullDoc()).join() !== before) record(handle, found.key, found.root, author);
    } catch (error) {
      warnOnce(error);
    }
    return result;
  };

  proto.change = function (this: AnyHandle, callbackOrValue: any, opts?: A.ChangeOptions<any>) {
    return stamped(this, opts, (o) => original.change.call(this, callbackOrValue, o));
  };
  proto.changeAt = function (this: AnyHandle, heads: any, callback: any, opts?: A.ChangeOptions<any>) {
    return stamped(this, opts, (o) => original.changeAt.call(this, heads, callback, o));
  };
  proto.sub = function (this: AnyHandle, ...segments: any[]) {
    const sub = (original.sub as (...s: any[]) => AnyHandle).apply(this, segments);
    if (sub !== this) {
      const root = rootOf(this);
      if (root) roots.set(sub, root);
    }
    return sub;
  } as Proto["sub"];

  return () => {
    proto.change = original.change;
    proto.changeAt = original.changeAt;
    proto.sub = original.sub;
    delete proto[INSTALLED];
  };
}
