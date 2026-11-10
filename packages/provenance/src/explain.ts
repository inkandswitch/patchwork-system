// Reads back which package version made each of a doc's changes.
import * as A from "@automerge/automerge/slim";
import type { DocHandle } from "@automerge/automerge-repo/slim";

/** `{ url }` from the doc's record, `"unrecorded"` for a key with no record, `null` for no key. */
export type ExplainedWriter = { url: string } | "unrecorded" | null;

/**
 * Who made a change, from the doc's `@patchwork.authors` record for its
 * author: their device's verifying key and contact card url. Self-reported,
 * not verified. `"unrecorded"` for an author with no record, `null` for none.
 */
export type ExplainedPerson = { device: string; contact?: string } | "unrecorded" | null;

export type ExplainedChange = {
  hash: string;
  /** Seconds since the epoch, as the writer's clock had it. */
  time: number;
  actor: string;
  /** The changes this one was made on top of. */
  deps: string[];
  /** The caller's own message, without the `pw:` line. */
  message: string | null;
  key: string | null;
  /** Where in the writer the change was made, `path:line:column`, if it said. */
  at: string | null;
  writer: ExplainedWriter;
  /** The change's author id, if it has one. */
  author: string | null;
  person: ExplainedPerson;
};

export type WriterSummary = {
  key: string | null;
  writer: ExplainedWriter;
  count: number;
  first: number;
  last: number;
};

const KEY_LINE = /(?:^|\n)pw:([1-9A-HJ-NP-Za-km-z]{8,})(?: (\S+:\d+:\d+))?$/;

export type ParsedMessage = { message: string | null; key: string | null; at: string | null };

export function parseMessage(message: string | null): ParsedMessage {
  if (message === null) return { message: null, key: null, at: null };
  const match = KEY_LINE.exec(message);
  if (!match) return { message, key: null, at: null };
  const rest = message.slice(0, match.index);
  return { message: rest === "" ? null : rest, key: match[1]!, at: match[2] ?? null };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A lookup from key to writer, against `doc`'s `@patchwork.writers` as it is now. */
export function writerResolver(doc: unknown): (key: string | null) => ExplainedWriter {
  const meta = (doc as any)?.["@patchwork"];
  const writers = isPlainObject(meta) && isPlainObject(meta.writers) ? meta.writers : undefined;
  return (key) => {
    if (key === null) return null;
    const record = writers && Object.hasOwn(writers, key) ? writers[key] : undefined;
    return isPlainObject(record) && typeof record.url === "string" ? { url: record.url } : "unrecorded";
  };
}

/** A lookup from author id to person, against `doc`'s `@patchwork.authors` as it is now. */
export function personResolver(doc: unknown): (author: string | null) => ExplainedPerson {
  const meta = (doc as any)?.["@patchwork"];
  const authors = isPlainObject(meta) && isPlainObject(meta.authors) ? meta.authors : undefined;
  return (author) => {
    if (author === null) return null;
    const record = authors && Object.hasOwn(authors, author) ? authors[author] : undefined;
    if (!isPlainObject(record) || typeof record.device !== "string") return "unrecorded";
    return typeof record.contact === "string"
      ? { device: record.device, contact: record.contact }
      : { device: record.device };
  };
}

/** A change's metadata, read: everything but the parts resolved against the doc's records. */
export type ReadChange = Omit<ExplainedChange, "writer" | "person">;

export function readChange(change: A.ChangeMetadata): ReadChange {
  return {
    hash: change.hash,
    time: change.time,
    actor: change.actor,
    deps: change.deps,
    ...parseMessage(change.message),
    author: change.author ?? null,
  };
}

/** Resolves read changes against `doc`'s records as they are now. */
export function explainer(doc: unknown): (change: ReadChange) => ExplainedChange {
  const writer = writerResolver(doc);
  const person = personResolver(doc);
  return (change) => ({ ...change, writer: writer(change.key), person: person(change.author) });
}

function rows(handle: DocHandle<unknown>, since: A.Heads): ExplainedChange[] {
  const doc = handle.fullDoc() as any;
  const resolve = explainer(doc);
  // Sort concurrent changes by time, keeping reverse causal order for ties.
  return A.getChangesMetaSince(doc, since)
    .reverse()
    .sort((a, b) => b.time - a.time)
    .map((change) => resolve(readChange(change)));
}

/** A doc's changes, newest first, each with the package version that made it. */
export function explain(
  handle: DocHandle<unknown>,
  { limit = 50, since = [] }: { limit?: number; since?: A.Heads } = {},
): ExplainedChange[] {
  return rows(handle, since).slice(0, limit);
}

/** A doc's whole history grouped by writer, most changes first. */
export function explainSummary(handle: DocHandle<unknown>): WriterSummary[] {
  const groups = new Map<string | null, WriterSummary>();
  for (const row of rows(handle, [])) {
    const group = groups.get(row.key);
    if (group) {
      group.count++;
      group.first = Math.min(group.first, row.time);
      group.last = Math.max(group.last, row.time);
    } else {
      groups.set(row.key, { key: row.key, writer: row.writer, count: 1, first: row.time, last: row.time });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
