// Stamps every change made through a DocHandle with the package version that
// made it (`pw:<key>` in the change message), and records each key's package
// root once per doc under `@patchwork.writers`, in a change of its own.
import * as A from "@automerge/automerge/slim";
import { DocHandle } from "@automerge/automerge-repo/slim";
import { findWriter, MAX_KEY_LENGTH, writerKey, type WriterContext } from "./writer.js";

export type ProvenanceOptions = WriterContext & {
  /** Where the stack comes from; tests choose it. Defaults to a fresh Error's stack, 50 frames deep. */
  stack?: () => string | undefined;
};

export const WRITERS = "writers";
const PATCHWORK = "@patchwork";

let warned = false;
function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn("patchwork provenance: a change went unstamped or unrecorded", error);
}

export function composeMessage(message: string | undefined, key: string): string {
  return message ? `${message}\npw:${key}` : `pw:${key}`;
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

  const record = (handle: AnyHandle, key: string, url: string) => {
    const meta = (handle.fullDoc() as any)?.[PATCHWORK];
    if (meta !== undefined) {
      if (!isPlainObject(meta)) return;
      const writers = meta[WRITERS];
      if (writers !== undefined && !isPlainObject(writers)) return;
      if (writers && key in writers) return;
    }
    const root = rootOf(handle);
    if (!root) return;
    original.change.call(
      root,
      (doc: any) => {
        if (doc[PATCHWORK] === undefined) {
          doc[PATCHWORK] = { [WRITERS]: { [key]: { url } } };
        } else if (doc[PATCHWORK][WRITERS] === undefined) {
          doc[PATCHWORK][WRITERS] = { [key]: { url } };
        } else {
          doc[PATCHWORK][WRITERS][key] = { url };
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
    let found: { root: string; key: string } | null = null;
    let before = "";
    try {
      if (!handle.isReadOnly()) {
        const writer_ = writer();
        if (writer_) {
          found = { root: writer_.root, key: keyFor(handle, writer_.root, writer_.key) };
          before = A.getHeads(handle.fullDoc()).join();
        }
      }
    } catch (error) {
      warnOnce(error);
      found = null;
    }
    if (!found) return run(opts);
    const result = run({ ...opts, message: composeMessage(opts?.message, found.key) });
    try {
      if (A.getHeads(handle.fullDoc()).join() !== before) record(handle, found.key, found.root);
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
