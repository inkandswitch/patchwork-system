import * as Automerge from "@automerge/automerge/slim";
import { isEqual } from "lodash";
import type { TLRecord, TLShapeId } from "@tldraw/tldraw";
import type { TLDrawDoc } from "./datatype.ts";

// A record-level diff of the tldraw store between a baseline version and the
// current one. Modelled on how `codemirror-base` diffs text: we view the doc
// at the baseline heads and compare it against the live doc. The granularity
// here is whole records (shapes) rather than text spans.
export type ShapeDiff = {
  added: Set<TLShapeId>;
  changed: Set<TLShapeId>;
  // Deleted shapes no longer exist in the live store, so we keep a plain
  // clone of the baseline record to re-render it as a ghost.
  deleted: TLRecord[];
};

const isShapeId = (id: string): id is TLShapeId => id.startsWith("shape:");

// Compute which shapes were added / changed / deleted between the doc at
// `headsBefore` and its current state. Only `shape:*` records are considered
// — the store also holds `camera:`, `instance:`, `pointer:` and
// `instance_presence:` records (presence is written live by every peer) which
// must not show up as diffs.
export function diffStore(
  doc: TLDrawDoc,
  headsBefore: Automerge.Heads
): ShapeDiff {
  const before = Automerge.view<TLDrawDoc>(doc, headsBefore);
  const beforeStore = (before.store ?? {}) as Record<string, TLRecord>;
  const afterStore = (doc.store ?? {}) as Record<string, TLRecord>;

  const added = new Set<TLShapeId>();
  const changed = new Set<TLShapeId>();
  const deleted: TLRecord[] = [];

  for (const id in afterStore) {
    if (!isShapeId(id)) continue;
    if (!(id in beforeStore)) {
      added.add(id);
    } else if (!isEqual(beforeStore[id], afterStore[id])) {
      changed.add(id);
    }
  }

  for (const id in beforeStore) {
    if (!isShapeId(id)) continue;
    if (!(id in afterStore)) {
      // Clone via JSON so the record survives outside the Automerge doc and
      // carries no proxies (matches how the store snapshot is loaded).
      deleted.push(JSON.parse(JSON.stringify(beforeStore[id])) as TLRecord);
    }
  }

  return { added, changed, deleted };
}

export const hasDiff = (d: ShapeDiff | null | undefined): d is ShapeDiff =>
  !!d && (d.added.size > 0 || d.changed.size > 0 || d.deleted.length > 0);
