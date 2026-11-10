// `explain`, read a little at a time, for a view that follows a doc as it
// changes: each update reads only the changes since the last one.
import * as A from "@automerge/automerge/slim";
import { parseMessage, writerResolver, type ExplainedChange, type WriterSummary } from "./explain.js";

type Change = Omit<ExplainedChange, "writer">;
type Group = Omit<WriterSummary, "writer">;

export type History = {
  /** Reads the changes made since the last update; returns how many there were. */
  update(doc: A.Doc<unknown>): number;
  /** The newest changes read so far, newest first, resolved against `doc`'s record. */
  recent(doc: A.Doc<unknown>): ExplainedChange[];
  /** Every change read so far, grouped by writer, most changes first. */
  summary(doc: A.Doc<unknown>): WriterSummary[];
};

export function createHistory({ limit = 50 }: { limit?: number } = {}): History {
  let heads: A.Heads = [];
  /** Newest first. */
  let recent: Change[] = [];
  const groups = new Map<string | null, Group>();

  return {
    update(doc) {
      const changes = A.getChangesMetaSince(doc, heads);
      heads = A.getHeads(doc);
      if (changes.length === 0) return 0;
      const added: Change[] = [];
      for (const change of changes) {
        const { message, key } = parseMessage(change.message);
        added.push({ hash: change.hash, time: change.time, actor: change.actor, message, key });
        const group = groups.get(key);
        if (group) {
          group.count++;
          group.first = Math.min(group.first, change.time);
          group.last = Math.max(group.last, change.time);
        } else {
          groups.set(key, { key, count: 1, first: change.time, last: change.time });
        }
      }
      // Newest first by time, like `explain`; reverse causal order breaks ties.
      recent = added
        .reverse()
        .concat(recent)
        .sort((a, b) => b.time - a.time)
        .slice(0, limit);
      return changes.length;
    },

    recent(doc) {
      const resolve = writerResolver(doc);
      return recent.map((change) => ({ ...change, writer: resolve(change.key) }));
    },

    summary(doc) {
      const resolve = writerResolver(doc);
      return [...groups.values()]
        .map((group) => ({ ...group, writer: resolve(group.key) }))
        .sort((a, b) => b.count - a.count);
    },
  };
}
