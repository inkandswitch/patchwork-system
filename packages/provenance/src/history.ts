// `explain`, read a little at a time, for a view that follows a doc as it
// changes: each update reads only the changes since the last one. Keeps the
// newest changes in full, and counts every change by writer and by author.
import * as A from "@automerge/automerge/slim";
import {
  explainer,
  personResolver,
  readChange,
  writerResolver,
  type ExplainedChange,
  type ExplainedPerson,
  type ReadChange,
  type WriterSummary,
} from "./explain.js";

export type PersonSummary = {
  author: string | null;
  person: ExplainedPerson;
  count: number;
  first: number;
  last: number;
};

/**
 * A run of changes by one writer and one author with no gap longer than the
 * session gap between them, newest first: one block on the timeline.
 */
export type Session = {
  key: string | null;
  author: string | null;
  changes: ExplainedChange[];
  first: number;
  last: number;
};

export type History = {
  /** Reads the changes made since the last update; returns how many there were. */
  update(doc: A.Doc<unknown>): number;
  /** How many changes have been read, kept or not. */
  readonly total: number;
  /** The newest kept changes, newest first, resolved against `doc`'s records. */
  recent(doc: A.Doc<unknown>, limit?: number): ExplainedChange[];
  /** Every change read so far, grouped by writer, most changes first. */
  summary(doc: A.Doc<unknown>): WriterSummary[];
  /** Every change read so far, grouped by author, most changes first. */
  people(doc: A.Doc<unknown>): PersonSummary[];
  /** The kept changes as sessions, newest first. */
  sessions(doc: A.Doc<unknown>, gapSeconds?: number): Session[];
};

type Count = { count: number; first: number; last: number };

function tally<K>(counts: Map<K, Count>, key: K, time: number) {
  const count = counts.get(key);
  if (count) {
    count.count++;
    count.first = Math.min(count.first, time);
    count.last = Math.max(count.last, time);
  } else {
    counts.set(key, { count: 1, first: time, last: time });
  }
}

export function createHistory({ keep = 2000 }: { keep?: number } = {}): History {
  let heads: A.Heads = [];
  let total = 0;
  /** Newest first. */
  let kept: ReadChange[] = [];
  const byWriter = new Map<string | null, Count>();
  const byAuthor = new Map<string | null, Count>();

  return {
    get total() {
      return total;
    },

    update(doc) {
      const changes = A.getChangesMetaSince(doc, heads);
      heads = A.getHeads(doc);
      if (changes.length === 0) return 0;
      total += changes.length;
      const added = changes.map(readChange);
      for (const change of added) {
        tally(byWriter, change.key, change.time);
        tally(byAuthor, change.author, change.time);
      }
      // Newest first by time, like `explain`; reverse causal order breaks ties.
      kept = added
        .reverse()
        .concat(kept)
        .sort((a, b) => b.time - a.time)
        .slice(0, keep);
      return changes.length;
    },

    recent(doc, limit = 50) {
      return kept.slice(0, limit).map(explainer(doc));
    },

    summary(doc) {
      const writer = writerResolver(doc);
      return [...byWriter]
        .map(([key, count]) => ({ key, writer: writer(key), ...count }))
        .sort((a, b) => b.count - a.count);
    },

    people(doc) {
      const person = personResolver(doc);
      return [...byAuthor]
        .map(([author, count]) => ({ author, person: person(author), ...count }))
        .sort((a, b) => b.count - a.count);
    },

    sessions(doc, gapSeconds = 5 * 60) {
      const explain = explainer(doc);
      const sessions: Session[] = [];
      let current: Session | undefined;
      for (const read of kept) {
        const change = explain(read);
        if (
          current &&
          current.key === change.key &&
          current.author === change.author &&
          current.first - change.time <= gapSeconds
        ) {
          current.changes.push(change);
          current.first = change.time;
        } else {
          current = { key: change.key, author: change.author, changes: [change], first: change.time, last: change.time };
          sessions.push(current);
        }
      }
      return sessions;
    },
  };
}
