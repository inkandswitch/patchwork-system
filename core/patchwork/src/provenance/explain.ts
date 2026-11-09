// Reads back which package version made each of a doc's changes.
import * as A from "@automerge/automerge/slim";
import type { DocHandle } from "@automerge/automerge-repo/slim";

/** `{ url }` from the doc's record, `"unrecorded"` for a key with no record, `null` for no key. */
export type ExplainedWriter = { url: string } | "unrecorded" | null;

export type ExplainedChange = {
  hash: string;
  /** Seconds since the epoch, as the writer's clock had it. */
  time: number;
  actor: string;
  /** The caller's own message, without the `pw:` line. */
  message: string | null;
  key: string | null;
  writer: ExplainedWriter;
};

export type WriterSummary = {
  key: string | null;
  writer: ExplainedWriter;
  count: number;
  first: number;
  last: number;
};

const KEY_LINE = /(?:^|\n)pw:([1-9A-HJ-NP-Za-km-z]{8,})$/;

export function parseMessage(message: string | null): { message: string | null; key: string | null } {
  if (message === null) return { message: null, key: null };
  const match = KEY_LINE.exec(message);
  if (!match) return { message, key: null };
  const rest = message.slice(0, match.index);
  return { message: rest === "" ? null : rest, key: match[1] };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function rows(handle: DocHandle<unknown>, since: A.Heads): ExplainedChange[] {
  const doc = handle.fullDoc() as any;
  const meta = doc?.["@patchwork"];
  const writers = isPlainObject(meta) && isPlainObject(meta.writers) ? meta.writers : undefined;
  const resolve = (key: string | null): ExplainedWriter => {
    if (key === null) return null;
    const record = writers?.[key];
    return isPlainObject(record) && typeof record.url === "string" ? { url: record.url } : "unrecorded";
  };
  // Changes come oldest first in causal order; reversed, they read newest first.
  return A.getChangesMetaSince(doc, since)
    .reverse()
    .map((change) => {
      const { message, key } = parseMessage(change.message);
      return {
        hash: change.hash,
        time: change.time,
        actor: change.actor,
        message,
        key,
        writer: resolve(key),
      };
    });
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
