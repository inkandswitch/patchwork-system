import * as A from "@automerge/automerge/slim";
import type { Heads, Prop } from "@automerge/automerge/slim";

import type { CopyMap } from "./copies.js";
import { mapCharsBack, pathKey, textSplices } from "./ranges.js";
import { objectAt, stableJSON } from "./visible.js";

type Backend = ReturnType<typeof A.getBackend>;
type ObjType = "map" | "list" | "text" | "table";
// `getAll` entries: `[type, objId]` for objects, `[datatype, value, opId]`
// for scalars.
type Entry = [string, unknown, string?];

/**
 * A decoded op as `getDecodedChangeByHash` returns it. The published `Op`
 * type lacks `elemId` (for an insert: the element it goes after; otherwise
 * the element itself) and `insert`.
 */
export type DecodedOp = {
  action: string;
  obj: string;
  key?: string;
  elemId?: string;
  insert?: boolean;
  value?: unknown;
  datatype?: string;
  pred: string[];
};

export type OpRecord = {
  id: string;
  op: DecodedOp;
  /** The heads the op's change was made at. */
  deps: Heads;
  hash: string;
  /** The change's position in the realm's chain ({@link InverseContext.positions}). */
  seq: number;
  order: number;
};

/** Ids the inverse needs to find again, shared by every step of a history. */
export type InverseContext = {
  copies: CopyMap;
  /** Element (or value op) id → the sequence it lives in. */
  owners: Map<string, string>;
  /**
   * List element id → every value op this realm wrote into it (its insert
   * included), and value op → element. `getAll` names a list element by the
   * op that wrote its current value, so finding one means trying them all.
   */
  values: Map<string, Set<string>>;
  elements: Map<string, string>;
  /**
   * Element id → `seq` of the realm's change that inserted it. The realm's
   * changes form a chain, so an element it created existed at the heads of
   * a later change of its own iff its `seq` is lower.
   */
  created: Map<string, number>;
  /**
   * Change hash → its position in the realm's chain, the `seq` of its ops. A
   * history restored from several actors' changes can't use their own
   * sequence numbers, which count each actor's changes separately.
   */
  positions: Map<string, number>;
  ignore: (path: Prop[]) => boolean;
};

export type ConflictPolicy = "skip" | "force";

export type Skipped = {
  path: Prop[];
  reason: "conflict" | "unreachable";
};

export type InverseOutcome = {
  skipped: Skipped[];
};

type Value =
  | { kind: "absent" }
  | { kind: "scalar"; datatype: string; value: unknown }
  | { kind: "object"; type: ObjType; id: string; heads: Heads };

type Restore = {
  kind: "restore";
  order: number;
  obj: string;
  key?: string;
  elem?: string;
  /** Ids of the value being restored; they map to the restored op. */
  ids: string[];
  /** The step's last op on the target: undefined if it deleted the key. */
  last?: string;
  value: Value;
};

type Reinsert = {
  kind: "reinsert";
  order: number;
  obj: string;
  type: ObjType;
  elem: string;
  ids: string[];
  value: Value;
  /** The heads the element was deleted at, and its index there. */
  heads: Heads;
  index: number;
  /** Lists only: the tombstone's position in the current document. */
  position?: number;
  /** `seq` of the change that deleted the element. */
  seq: number;
  /**
   * The element before it where it was deleted, unless that is the previous
   * element this inverse re-inserts (which it then follows anyway).
   */
  before?: string;
  /** Texts: the formats the element had where it was deleted. */
  formats?: Record<string, unknown>;
};

type Remove = {
  kind: "remove";
  order: number;
  obj: string;
  elem: string;
};

type Increment = {
  kind: "increment";
  order: number;
  obj: string;
  key?: string;
  elem?: string;
  delta: number;
};

/**
 * A format (a rich-text mark) the step set or removed over a range,
 * restored per segment to the value it had there before.
 */
type Format = {
  kind: "format";
  order: number;
  obj: string;
  name: string;
  /** The step's value: what the range should still have; null for none. */
  value: unknown;
  expand: "before" | "after" | "both" | "none";
  segments: Array<{
    first: string;
    last: string;
    prev: unknown;
    /** Where the segment was, `[from, to)` at `heads`. */
    from: number;
    to: number;
    heads: Heads;
  }>;
};

type Action = Restore | Reinsert | Remove | Increment | Format;

type Empty = Record<string, never> | never[] | string;
type Datatype = "int" | "uint" | "f64" | "counter" | "timestamp" | "bytes";

export type InversePlan = {
  actions: Action[];
};

const MAKE = /^make(Map|List|Text|Table)$/;

/** `created` of an element written by the inverse being applied. */
const PENDING = Infinity;

export function opsOf(
  be: Backend,
  hash: string,
  order: { n: number },
  positions: Map<string, number>
) {
  const change = be.getDecodedChangeByHash(hash);
  if (!change) return [];
  const seq = positions.get(hash) ?? change.seq;
  return (change.ops as unknown as DecodedOp[]).map((op, i): OpRecord => ({
    id: `${change.startOp + i}@${change.actor}`,
    op,
    deps: change.deps,
    hash,
    seq,
    order: order.n++,
  }));
}

function idOf(entry: Entry): string {
  return (entry.length === 2 ? entry[1] : entry[2]) as string;
}

/** `ids` with every other value op of the same list elements. */
export function expand(ctx: InverseContext, ids: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    const elem = ctx.elements.get(id) ?? id;
    out.add(elem);
    for (const value of ctx.values.get(elem) ?? []) out.add(value);
  }
  return [...out];
}

function typeOf(be: Backend, obj: string, heads?: Heads): ObjType {
  if (obj === "_root") return "map";
  return be.objInfo(obj, heads).type as ObjType;
}

/** The path of `obj`, or undefined if it isn't reachable at `heads`. */
export function pathOf(
  be: Backend,
  obj: string,
  heads?: Heads
): Prop[] | undefined {
  if (obj === "_root") return [];
  try {
    return be.objInfo(obj, heads).path;
  } catch {
    return undefined;
  }
}

/**
 * The index of the element whose value op is one of `ids`, in `obj` at
 * `heads`. Text elements are found by cursor; list elements by scanning,
 * because the JavaScript API only has cursors on text (the Rust core has
 * them on lists too).
 */
function indexOf(
  be: Backend,
  obj: string,
  type: ObjType,
  ids: readonly string[],
  heads: Heads | undefined,
  owners: Map<string, string>,
  home: string = obj
): number {
  if (type === "text") {
    for (const id of ids) {
      // A cursor naming another object's element panics the wasm module;
      // only ask about elements known to live in `obj`. Ids with no recorded
      // owner live in `home`, the object they were read from.
      if ((owners.get(id) ?? home) !== obj) continue;
      let pos: number;
      try {
        pos = be.getCursorPosition(obj, id as A.Cursor, heads);
      } catch {
        continue;
      }
      const entries = be.getAll(obj, pos, heads) as Entry[];
      if (entries.some((e) => idOf(e) === id)) return pos;
    }
    return -1;
  }
  const wanted = new Set(ids);
  const length = be.length(obj, heads);
  for (let i = 0; i < length; i++) {
    const entries = be.getAll(obj, i, heads) as Entry[];
    if (entries.some((e) => wanted.has(idOf(e)))) return i;
  }
  return -1;
}

function valueAt(
  be: Backend,
  obj: string,
  prop: Prop,
  heads: Heads,
  ids: readonly string[]
): Value {
  const entries = (be.getAll(obj, prop, heads) as Entry[]).filter((e) =>
    ids.includes(idOf(e))
  );
  const entry = entries[entries.length - 1];
  if (!entry) return { kind: "absent" };
  if (entry.length === 2) {
    return {
      kind: "object",
      type: entry[0] as ObjType,
      id: idOf(entry),
      heads,
    };
  }
  return { kind: "scalar", datatype: entry[0], value: entry[1] };
}

/**
 * Where a tombstone sits at `heads`: the number of visible elements before
 * it. Text has cursors, which throw for a deleted element with nothing
 * visible after it once the document has changed since; then it's at the
 * end. Lists carry the element's index from its deletion through
 * `diffPath` patches.
 */
function tombstoneAt(be: Backend, r: Reinsert, heads: Heads): number {
  if (r.type === "text") {
    try {
      return be.getCursorPosition(r.obj, r.elem as A.Cursor, heads);
    } catch {
      return be.length(r.obj, heads);
    }
  }
  // `diff` emits a sequence's patches in document order, tombstones
  // included. Until the element's own deletion goes by, it is visible and
  // its index exact; after it, an insertion at its position comes after it.
  let pos = r.index;
  let passed = false;
  const patches = be.diffPath(r.obj, r.heads, heads, { recursive: false });
  const depth = (pathOf(be, r.obj, heads) ?? []).length;
  for (const patch of patches) {
    if (patch.path.length !== depth + 1) continue;
    const at = patch.path[depth] as number;
    if (patch.action === "del") {
      const n = patch.length ?? 1;
      if (!passed && at <= pos && pos < at + n) {
        passed = true;
        pos = at;
      } else if (pos >= at + n) pos -= n;
      else if (pos > at) pos = at;
    } else if (patch.action === "insert" || patch.action === "splice") {
      const n =
        patch.action === "insert" ? patch.values.length : patch.value.length;
      if (pos > at || (pos === at && !passed)) pos += n;
    }
  }
  return pos;
}

/**
 * Plan the inverse of `hashes` (the realm's changes forming one step).
 * Everything that reads at historical heads happens here, outside
 * `handle.change()`: some reads (`getHeads`, `diffPath`) commit the pending
 * operations as a change of their own when called inside it
 * (automerge#1607).
 */
export function planInverse(
  doc: A.Doc<unknown>,
  hashes: readonly string[],
  ctx: InverseContext
): InversePlan {
  const be = A.getBackend(doc);
  const now = A.getHeads(doc);
  const counter = { n: 0 };
  const ops = hashes.flatMap((hash) => opsOf(be, hash, counter, ctx.positions));

  const created = new Set<string>();
  for (const { id, op } of ops) if (MAKE.test(op.action)) created.add(id);

  const ignored = (r: OpRecord): boolean => {
    const path = pathOf(be, r.op.obj, [r.hash]) ?? pathOf(be, r.op.obj, r.deps);
    if (!path) return false;
    return ctx.ignore(r.op.key !== undefined ? [...path, r.op.key] : path);
  };

  // Changes that set or removed formats, with the expand of each format.
  const formatted = new Map<string, Map<string, Format["expand"]>>();
  const inserted = new Map<string, OpRecord>();
  const deleted: OpRecord[] = [];
  // First and last op per map key or overwritten list element.
  const keyed = new Map<string, { first: OpRecord; last: OpRecord }>();
  const incs = new Map<string, { record: OpRecord; delta: number }>();

  for (const r of ops) {
    const { op } = r;
    // Anything inside an object the step created goes with that object.
    if (created.has(op.obj)) continue;
    if (ignored(r)) continue;
    if (op.action === "markBegin") {
      // A mark is a markBegin and its markEnd, next to each other; their
      // expand flags say whether the format grows at either end.
      const end = ops[ops.indexOf(r) + 1]?.op;
      const before = !!(op as { expand?: boolean }).expand;
      const after = !!(end as { expand?: boolean } | undefined)?.expand;
      let names = formatted.get(r.hash);
      if (!names) formatted.set(r.hash, (names = new Map()));
      names.set(
        (op as { name?: string }).name!,
        before && after ? "both" : before ? "before" : after ? "after" : "none"
      );
      continue;
    }
    if (op.action === "markEnd") continue;
    if (op.insert) {
      inserted.set(r.id, r);
      continue;
    }
    const target = `${op.obj}\0${op.key ?? op.elemId}`;
    if (op.action === "inc") {
      const entry = incs.get(target);
      if (entry) entry.delta += Number(op.value);
      else incs.set(target, { record: r, delta: Number(op.value) });
      continue;
    }
    if (op.elemId !== undefined && op.action === "del") {
      deleted.push(r);
      continue;
    }
    const entry = keyed.get(target);
    if (entry) entry.last = r;
    else keyed.set(target, { first: r, last: r });
  }

  const actions: Action[] = [];
  const dropped = new Set<string>();
  const deletedElems = new Set(deleted.map((r) => r.op.elemId!));

  const textIndex = textDeletionIndices(be, deleted, ctx.owners);
  const texts = new Map<string, string>();
  const textAt = (obj: string, heads: Heads) => {
    const key = `${obj}|${heads.join(",")}`;
    let text = texts.get(key);
    if (text === undefined) texts.set(key, (text = be.text(obj, heads)));
    return text;
  };

  for (const r of deleted) {
    const elem = r.op.elemId!;
    const target = `${r.op.obj}\0${elem}`;
    const overwrite = keyed.get(target);
    keyed.delete(target);
    // Inserted and deleted within the step: nothing to undo.
    if (inserted.has(elem)) {
      dropped.add(elem);
      continue;
    }
    const type = typeOf(be, r.op.obj, r.deps);
    // An element overwritten and then deleted comes back with the value it
    // had before the overwrite.
    const first =
      overwrite && overwrite.first.order < r.order ? overwrite.first : r;
    const index =
      textIndex.get(r.id) ??
      indexOf(be, r.op.obj, type, r.op.pred, r.deps, ctx.owners);
    const firstIndex =
      first === r
        ? index
        : indexOf(be, r.op.obj, type, first.op.pred, first.deps, ctx.owners);
    if (index < 0 || firstIndex < 0) continue;
    // A character comes from the text at those heads, read once per object
    // and heads; anything else (a block marker) from its value op.
    const char =
      type === "text" && first === r
        ? textAt(r.op.obj, r.deps)[index]
        : undefined;
    const value: Value =
      char !== undefined && char !== "\ufffc"
        ? { kind: "scalar", datatype: "str", value: char }
        : valueAt(be, r.op.obj, firstIndex, first.deps, first.op.pred);

    // A deletion and its own restore (an undo and a redo in one run) cancel,
    // unless the step deleted the restored copy again. The copy is the
    // element; if its value changed within the step, restore that.
    const restored = ctx.copies
      .chain(elem)
      .find((id) => inserted.has(id) && !deletedElems.has(id));
    if (restored) {
      dropped.add(restored);
      const copyTarget = `${r.op.obj}\0${restored}`;
      const later = keyed.get(copyTarget);
      keyed.delete(copyTarget);
      // Unchanged unless the value is an object: edits inside the copy
      // (made within the step) don't show in its identity, so it gets the
      // object as it was before the step.
      if (first === r && !later && value.kind !== "object") continue;
      actions.push({
        kind: "restore",
        order: (later?.last ?? r).order,
        obj: r.op.obj,
        elem: restored,
        ids: first.op.pred,
        last: later?.last.id ?? restored,
        value,
      });
      continue;
    }
    actions.push({
      kind: "reinsert",
      order: r.order,
      obj: r.op.obj,
      type,
      elem,
      ids: [elem, ...r.op.pred, ...first.op.pred],
      value,
      heads: r.deps,
      index,
      seq: r.seq,
    });
  }

  for (const r of inserted.values()) {
    if (dropped.has(r.id)) continue;
    actions.push({ kind: "remove", order: r.order, obj: r.op.obj, elem: r.id });
  }

  for (const { first, last } of keyed.values()) {
    const { obj, key, elemId } = first.op;
    // Don't restore the value of an element the step inserted: it goes.
    if (elemId !== undefined && inserted.has(elemId)) continue;
    let value: Value = { kind: "absent" };
    if (first.op.pred.length > 0) {
      let prop: Prop | undefined = key;
      if (elemId !== undefined) {
        const type = typeOf(be, obj, first.deps);
        const index = indexOf(
          be,
          obj,
          type,
          first.op.pred,
          first.deps,
          ctx.owners
        );
        if (index < 0) continue;
        prop = index;
      }
      value = valueAt(be, obj, prop!, first.deps, first.op.pred);
    }
    actions.push({
      kind: "restore",
      order: last.order,
      obj,
      ...(key !== undefined ? { key } : { elem: elemId! }),
      ids: first.op.pred,
      ...(last.op.action === "del" ? {} : { last: last.id }),
      value,
    });
  }

  for (const { record, delta } of incs.values()) {
    const { obj, key, elemId } = record.op;
    if (keyed.has(`${obj}\0${key ?? elemId}`)) continue;
    actions.push({
      kind: "increment",
      order: record.order,
      obj,
      ...(key !== undefined ? { key } : { elem: elemId! }),
      delta,
    });
  }

  // Re-insert deleted elements per object in document order. Two tombstones
  // are ordered by resolving the earlier-deleted one at the later deletion's
  // heads: it precedes the other iff its position is <= the other's index.
  const reinserts = actions.filter((a): a is Reinsert => a.kind === "reinsert");
  const byObj = new Map<string, Reinsert[]>();
  // The formats a re-inserted character comes back with: those it had
  // before the step. Where the step formatted its text before deleting it,
  // that means looking it up where the step began; otherwise the formats
  // where it was deleted are the same, and cheaper to read.
  const formatsAt = new Map<string, A.Mark[]>();
  const marksAt = (obj: string, heads: Heads) => {
    const key = `${obj}|${heads.join(",")}`;
    let marks = formatsAt.get(key);
    if (!marks) formatsAt.set(key, (marks = be.marks(obj, heads)));
    return marks;
  };
  const stepStart = ops[0]?.deps;
  const formattedBefore = (r: Reinsert) =>
    ops.some(
      (o) =>
        o.order < r.order && o.op.action === "markBegin" && o.op.obj === r.obj
    );
  for (const r of reinserts) {
    if (r.type === "text") {
      let heads = r.heads;
      let index = r.index;
      if (stepStart && formattedBefore(r)) {
        // The element, or, if it is a copy made within the step, the
        // nearest of its originals that was there when the step began.
        for (const id of [r.elem, ...ctx.copies.originals(r.elem)]) {
          if ((ctx.owners.get(id) ?? r.obj) !== r.obj) continue;
          const created = ctx.created.get(id);
          if (created !== undefined && created >= (ops[0]?.seq ?? 0)) continue;
          try {
            index = be.getCursorPosition(r.obj, id as A.Cursor, stepStart);
            heads = stepStart;
            break;
          } catch {
            // Not there when the step began.
          }
        }
      }
      r.formats = Object.fromEntries(
        marksAt(r.obj, heads)
          .filter((m) => m.start <= index && m.end > index)
          .map((m) => [m.name, m.value])
      );
    }
    let list = byObj.get(r.obj);
    if (!list) byObj.set(r.obj, (list = []));
    if (r.type === "list") r.position = tombstoneAt(be, r, now);
    list.push(r);
  }
  // A merge sort (V8's), with the historical lookups memoized: a deletion
  // of n elements must not cost n² cursor lookups at old heads.
  const memo = new Map<string, number>();
  for (const list of byObj.values()) {
    list.sort((a, b) => (precedes(be, a, b, memo) ? -1 : 1));
    // The element each one followed, looked up once per contiguous run.
    list.forEach((r, i) => {
      const previous = list[i - 1];
      if (previous && previous.seq === r.seq && previous.index === r.index - 1)
        return;
      if (r.index === 0) return;
      r.before =
        r.type === "text"
          ? be.getCursor(r.obj, r.index - 1, r.heads)
          : idOf((be.getAll(r.obj, r.index - 1, r.heads) as Entry[]).at(-1)!);
      if (!ctx.owners.has(r.before)) ctx.owners.set(r.before, r.obj);
    });
  }

  const restores = actions
    .filter((a) => a.kind === "restore")
    .sort((a, b) => b.order - a.order);
  const removes = actions
    .filter((a) => a.kind === "remove")
    .sort((a, b) => b.order - a.order);
  const increments = actions.filter((a) => a.kind === "increment");
  const formats = planFormats(be, ops, formatted, created, ctx).sort(
    (a, b) => b.order - a.order
  );
  return {
    // Removals first: they find their elements by id, and once they are
    // gone, the copies they were won't stand between a tombstone and its
    // place.
    actions: [
      ...restores,
      ...removes,
      ...[...byObj.values()].flat(),
      ...increments,
      // Last: they find their ranges by elements the others may restore.
      ...formats,
    ],
  };
}

/**
 * The index each deleted character had where its change deleted it, for
 * all the step's text deletions at once. A lookup at old heads costs as
 * much as reading the whole text there, so not one per character: the
 * delete ops of one change whose tombstones now share a position, and are
 * consecutive, are one contiguous deletion; its first and last element are
 * looked up, and if they span the run, the rest lie between. Anything else
 * is left to the per-element lookup.
 */
function textDeletionIndices(
  be: Backend,
  deleted: readonly OpRecord[],
  owners: Map<string, string>
): Map<string, number> {
  const out = new Map<string, number>();
  const at = (obj: string, elem: string, heads?: Heads) => {
    if ((owners.get(elem) ?? obj) !== obj) return -1;
    try {
      return be.getCursorPosition(obj, elem as A.Cursor, heads);
    } catch {
      return -1;
    }
  };
  let run: OpRecord[] = [];
  let runKey = "";
  const flush = () => {
    if (run.length > 1) {
      const { obj } = run[0]!.op;
      const deps = run[0]!.deps;
      const first = at(obj, run[0]!.op.elemId!, deps);
      const last = at(obj, run[run.length - 1]!.op.elemId!, deps);
      // In document order (a splice) or its reverse (an inverse's removals,
      // which run right to left).
      if (first >= 0 && last - first === run.length - 1) {
        run.forEach((r, k) => out.set(r.id, first + k));
      } else if (last >= 0 && first - last === run.length - 1) {
        run.forEach((r, k) => out.set(r.id, first - k));
      }
    }
    run = [];
    runKey = "";
  };
  for (const r of deleted) {
    const { obj, elemId } = r.op;
    if (obj === "_root" || typeOf(be, obj) !== "text") {
      flush();
      continue;
    }
    const key = `${r.hash}|${obj}|${at(obj, elemId!)}`;
    if (key !== runKey) flush();
    runKey = key;
    run.push(r);
  }
  flush();
  return out;
}

function precedes(
  be: Backend,
  a: Reinsert,
  b: Reinsert,
  memo: Map<string, number>
): boolean {
  // Deleted by one change: both were visible at its heads.
  if (a.seq === b.seq) return a.index < b.index;
  const [early, late] = a.order < b.order ? [a, b] : [b, a];
  const key = `${early.elem}|${late.heads.join(",")}`;
  let at = memo.get(key);
  if (at === undefined) {
    at = tombstoneAt(be, early, late.heads);
    memo.set(key, at);
  }
  const earlyFirst = at <= late.index;
  return earlyFirst === (early === a);
}

const EMPTY: Record<ObjType, () => Empty> = {
  map: () => ({}),
  table: () => ({}),
  list: () => [],
  text: () => "",
};

function lastId(be: Backend, obj: string, prop: Prop): string {
  const entries = be.getAll(obj, prop) as Entry[];
  return idOf(entries[entries.length - 1]!);
}

// Datatypes that `put` and `insert` need spelled out; the rest are inferred
// from the JavaScript value.
const EXPLICIT = new Set([
  "int",
  "uint",
  "f64",
  "counter",
  "timestamp",
  "bytes",
]);

/**
 * Copy `src` as it was at `heads` into a new object made by `create`,
 * recording every copied id: the object's, every scalar value op's and
 * every element's.
 */
function copyObject(
  be: Backend,
  src: string,
  type: ObjType,
  heads: Heads,
  ctx: InverseContext,
  create: (empty: Empty) => string
): string {
  const dst = create(EMPTY[type]());
  ctx.copies.set(src, dst);
  if (type === "text") {
    const text = be.text(src, heads);
    if (text.length > 0) be.splice(dst, 0, 0, text);
    for (const m of be.marks(src, heads)) {
      be.mark(
        dst,
        { start: m.start, end: m.end, expand: "none" },
        m.name,
        m.value
      );
    }
    for (let i = 0; i < text.length; i++) {
      const from = (be.getAll(src, i, heads) as Entry[]).at(-1);
      const id = lastId(be, dst, i);
      ctx.owners.set(id, dst);
      ctx.created.set(id, PENDING);
      if (from) {
        ctx.owners.set(idOf(from), src);
        ctx.copies.set(idOf(from), id);
      }
    }
    return dst;
  }
  const props: Prop[] =
    type === "list"
      ? Array.from({ length: be.length(src, heads) }, (_, i) => i)
      : be.keys(src, heads);
  for (const prop of props) {
    const entry = (be.getAll(src, prop, heads) as Entry[]).at(-1);
    if (!entry) continue;
    const insert = type === "list";
    if (insert) ctx.owners.set(idOf(entry), src);
    write(be, dst, prop, insert, valueOf(entry, heads), [idOf(entry)], ctx);
  }
  return dst;
}

function valueOf(entry: Entry, heads: Heads): Value {
  if (entry.length === 2) {
    return {
      kind: "object",
      type: entry[0] as ObjType,
      id: idOf(entry),
      heads,
    };
  }
  return { kind: "scalar", datatype: entry[0], value: entry[1] };
}

/** Put (or insert, in a sequence) `value` at `prop`, mapping `ids` to it. */
function write(
  be: Backend,
  obj: string,
  prop: Prop,
  insert: boolean,
  value: Value,
  ids: readonly string[],
  ctx: InverseContext
): void {
  let id: string;
  if (value.kind === "object" && insert && typeOf(be, obj) === "text") {
    // A rich-text block marker. Inserted like `splitBlock` inserts one, so
    // that bindings (such as @automerge/prosemirror) see a block, not an
    // object-replacement character.
    be.splitBlock(
      obj,
      prop as number,
      plainValue(be, value.id, value.heads) as never
    );
    id = lastId(be, obj, prop);
    mapCopy(be, value.id, id, value.heads, ctx);
  } else if (value.kind === "object") {
    id = copyObject(be, value.id, value.type, value.heads, ctx, (empty) =>
      insert
        ? be.insertObject(obj, prop as number, empty)
        : be.putObject(obj, prop, empty)
    );
  } else if (value.kind === "scalar") {
    const datatype = EXPLICIT.has(value.datatype)
      ? (value.datatype as Datatype)
      : undefined;
    const v = value.value as A.ScalarValue;
    if (insert && typeOf(be, obj) === "text") {
      be.splice(obj, prop as number, 0, String(v));
    } else if (insert) {
      be.insert(obj, prop as number, v, datatype);
    } else {
      be.put(obj, prop, v, datatype);
    }
    id = lastId(be, obj, prop);
  } else {
    be.delete(obj, prop);
    return;
  }
  if (insert) {
    ctx.owners.set(id, obj);
    ctx.created.set(id, PENDING);
  }
  for (const original of ids) ctx.copies.set(original, id);
}

/**
 * The value of `obj` at `heads` as plain JavaScript that keeps Automerge's
 * datatypes when written back: strings as `ImmutableString` (scalars, not
 * texts), counters as `Counter`.
 */
function plainValue(be: Backend, obj: string, heads: Heads): unknown {
  const entry = (prop: Prop): unknown => {
    const e = (be.getAll(obj, prop, heads) as Entry[]).at(-1);
    if (!e) return undefined;
    if (e.length === 2) {
      if (e[0] === "text") return be.text(idOf(e), heads);
      return plainValue(be, idOf(e), heads);
    }
    if (e[0] === "str") return new A.ImmutableString(e[1] as string);
    if (e[0] === "counter") return new A.Counter(e[1] as number);
    return e[1];
  };
  if (typeOf(be, obj, heads) === "list") {
    return Array.from({ length: be.length(obj, heads) }, (_, i) => entry(i));
  }
  return Object.fromEntries(
    be.keys(obj, heads).map((key) => [key, entry(key)])
  );
}

/** Record `dst` as the copy of `src` (at `heads`), with all it contains. */
function mapCopy(
  be: Backend,
  src: string,
  dst: string,
  heads: Heads,
  ctx: InverseContext
): void {
  ctx.copies.set(src, dst);
  const type = typeOf(be, src, heads);
  const props: Prop[] =
    type === "map" || type === "table"
      ? be.keys(src, heads)
      : Array.from({ length: be.length(src, heads) }, (_, i) => i);
  for (const prop of props) {
    const from = (be.getAll(src, prop, heads) as Entry[]).at(-1);
    const to = (be.getAll(dst, prop) as Entry[]).at(-1);
    if (!from || !to) continue;
    if (typeof prop === "number") ctx.owners.set(idOf(to), dst);
    ctx.copies.set(idOf(from), idOf(to));
    if (from.length === 2 && to.length === 2) {
      mapCopy(be, idOf(from), idOf(to), heads, ctx);
    }
  }
}

/**
 * Run the plan inside `handle.change()`, through the low-level backend and
 * by object id. Only reads that see the pending operations without
 * committing them happen here.
 */
export function executeInverse(
  be: Backend,
  plan: InversePlan,
  ctx: InverseContext,
  conflict: ConflictPolicy
): InverseOutcome {
  const skipped: Skipped[] = [];
  const reinserted = new Map<string, number>();
  const lastReinserted = new Map<string, string>();
  // Indices this inverse removed per object, in order.
  const removed = new Map<string, number[]>();
  // The elements the reinsertions of this inverse created.
  const ownCopies = new Set<string>();
  // Characters re-inserted, with the formats they had.
  const restoredText: RestoredChar[] = [];

  const reachable = (obj: string) => pathOf(be, obj) !== undefined;
  const find = (obj: string, home: string, ids: readonly string[]) => {
    const candidates = new Set<string>();
    for (const id of expand(ctx, ids)) {
      for (const c of ctx.copies.chain(id)) candidates.add(c);
    }
    // Newest copies first: they are the ones still visible.
    const list = expand(ctx, [...candidates].reverse());
    return indexOf(be, obj, typeOf(be, obj), list, undefined, ctx.owners, home);
  };

  const attempt = (action: Action): boolean => {
    const target = ctx.copies.follow(action.obj);
    if (!reachable(target)) return false;
    switch (action.kind) {
      case "remove": {
        const index = find(target, action.obj, [action.elem]);
        if (index >= 0) {
          be.splice(target, index, 1);
          let list = removed.get(target);
          if (!list) removed.set(target, (list = []));
          list.push(index);
        }
        return true;
      }
      case "increment": {
        const prop =
          action.key ??
          (action.elem ? find(target, action.obj, [action.elem]) : -1);
        if (prop === -1) return true;
        const entries = be.getAll(target, prop) as Entry[];
        if (entries.at(-1)?.[0] === "counter") {
          be.increment(target, prop, -action.delta);
        }
        return true;
      }
      case "restore": {
        const prop: Prop =
          action.key ??
          find(target, action.obj, [
            action.elem!,
            ...(action.last ? [action.last] : []),
          ]);
        const path = [...(pathOf(be, target) ?? []), prop];
        if (prop === -1) {
          skipped.push({ path, reason: "unreachable" });
          return true;
        }
        const current = (be.getAll(target, prop) as Entry[]).map(idOf);
        const expected = action.last
          ? ctx.copies.follow(action.last)
          : undefined;
        const unchanged = expected
          ? current.length === 1 && current[0] === expected
          : current.length === 0;
        if (!unchanged && conflict === "skip") {
          skipped.push({ path, reason: "conflict" });
          return true;
        }
        if (action.value.kind === "absent" && current.length === 0) return true;
        write(be, target, prop, false, action.value, action.ids, ctx);
        return true;
      }
      case "format": {
        format(be, action, target, ctx, conflict, skipped, ownCopies);
        return true;
      }
      case "reinsert": {
        for (const id of action.ids) {
          if (!ctx.owners.has(id)) ctx.owners.set(id, action.obj);
        }
        const position = reinsertPosition(
          be,
          action,
          target,
          ctx,
          reinserted,
          lastReinserted,
          removed,
          ownCopies
        );
        write(be, target, position, true, action.value, action.ids, ctx);
        reinserted.set(target, (reinserted.get(target) ?? 0) + 1);
        lastReinserted.set(action.obj, ctx.copies.follow(action.elem));
        ownCopies.add(ctx.copies.follow(action.elem));
        if (action.formats) {
          restoredText.push({
            target,
            home: action.obj,
            copy: ctx.copies.follow(action.elem),
            formats: action.formats,
          });
        }
        return true;
      }
    }
  };

  // Removals run right to left by where their elements are now, so that
  // the ops of one contiguous removal are in (reverse) document order, as
  // `textDeletionIndices` expects when this change is undone in turn.
  const at = new Map<Action, number>();
  for (const action of plan.actions) {
    if (action.kind !== "remove") continue;
    const target = ctx.copies.follow(action.obj);
    at.set(
      action,
      reachable(target) ? find(target, action.obj, [action.elem]) : -1
    );
  }
  const removes = plan.actions
    .filter((a) => a.kind === "remove")
    .sort((a, b) => at.get(b)! - at.get(a)!);
  let r = 0;
  const ordered = plan.actions.map((a) =>
    a.kind === "remove" ? removes[r++]! : a
  );

  // Restores repeat in rounds while one makes another's target reachable
  // (a restored record, then the text inside it).
  const rounds = (actions: Action[]) => {
    let pending = actions;
    for (;;) {
      const next = pending.filter((action) => !attempt(action));
      if (next.length === pending.length || next.length === 0) return next;
      pending = next;
    }
  };
  const pending = rounds(ordered.filter((a) => a.kind !== "format"));
  // Re-inserted characters are new elements: they get the formats the
  // deleted ones had, before the step's own formatting is undone (which
  // checks the formatting is still the step's).
  restoreFormats(be, restoredText, ctx);
  pending.push(...rounds(ordered.filter((a) => a.kind === "format")));
  for (const action of pending) {
    skipped.push({
      path: pathOf(be, action.obj, undefined) ?? [],
      reason: "unreachable",
    });
  }
  return { skipped };
}

function reinsertPosition(
  be: Backend,
  r: Reinsert,
  target: string,
  ctx: InverseContext,
  reinserted: Map<string, number>,
  lastReinserted: Map<string, string>,
  removed: Map<string, number[]>,
  ownCopies: Set<string>
): number {
  // The object was itself copied since: the tombstone isn't in the copy, so
  // insert after the nearest earlier element (at the deletion's heads) that
  // has a visible copy.
  // Copies this inverse re-inserted into the object already precede it
  // (they go in document order), wherever an index insert put them.
  const previous = lastReinserted.get(r.obj);
  const floor = previous
    ? indexOf(
        be,
        target,
        typeOf(be, target),
        expand(ctx, [previous]),
        undefined,
        ctx.owners
      ) + 1
    : 0;
  if (target !== r.obj) {
    const type = typeOf(be, target);
    for (let i = r.index - 1; i >= 0; i--) {
      const ids = (be.getAll(r.obj, i, r.heads) as Entry[]).map(idOf);
      const at = indexOf(
        be,
        target,
        type,
        expand(ctx, ids).map((id) => ctx.copies.follow(id)),
        undefined,
        ctx.owners,
        r.obj
      );
      if (at >= 0) return Math.max(at + 1, floor);
    }
    return floor;
  }

  let position: number;
  if (r.type === "text") {
    try {
      position = be.getCursorPosition(r.obj, r.elem as A.Cursor);
    } catch {
      position = be.length(r.obj);
    }
  } else {
    // Lists carry the tombstone's position from before this change, through
    // the removals this change made; the copies it re-inserted into the
    // object so far precede it.
    position = r.position ?? r.index;
    for (const index of removed.get(target) ?? [])
      if (index < position) position--;
    position += reinserted.get(target) ?? 0;
    position = Math.min(position, be.length(r.obj));
  }

  // An index insert lands right after the preceding visible element, so an
  // earlier copy can sit before tombstones its original followed: step back
  // over visible copies that were, or whose originals were, at the
  // deletion's heads after the deleted element. The copy itself decides if
  // it existed then, else its nearest original; in a text that may be a
  // tombstone (cursors resolve those), in a list it must be visible.
  while (position > 0) {
    const entry = (be.getAll(r.obj, position - 1) as Entry[]).at(-1);
    if (!entry) break;
    // This inverse re-inserts in document order: its own copies precede.
    if (ownCopies.has(idOf(entry))) break;
    const originals = ctx.copies
      .originals(idOf(entry))
      .filter((original) => ctx.owners.get(original) === r.obj);
    if (originals.length === 0) break;
    let after: boolean | undefined;
    // The copy itself, if it existed then, else its nearest original.
    for (const id of [idOf(entry), ...originals]) {
      const at = positionAt(be, r, id, ctx);
      if (at === undefined) continue;
      after = at > r.index;
      break;
    }
    if (!after) break;
    position--;
  }
  // An index insert can also land after tombstones it should precede (a
  // copy placed past them, formatting elements in the way): it goes after
  // the element it followed when it was deleted, wherever that is now.
  // If that element is gone too, the nearest earlier one (at the deletion's
  // heads) that is still there decides; each step back is a lookup at old
  // heads, so only a few are tried.
  let after = floor;
  if (r.before) {
    const type = typeOf(be, target);
    const locate = (id: string) =>
      indexOf(
        be,
        target,
        type,
        expand(ctx, ctx.copies.chain(id).reverse()),
        undefined,
        ctx.owners,
        r.obj
      );
    let at = locate(r.before);
    for (let i = r.index - 2; at < 0 && i >= Math.max(0, r.index - 32); i--) {
      const id =
        r.type === "text"
          ? be.getCursor(r.obj, i, r.heads)
          : idOf((be.getAll(r.obj, i, r.heads) as Entry[]).at(-1)!);
      if (!ctx.owners.has(id)) ctx.owners.set(id, r.obj);
      at = locate(id);
    }
    if (at >= 0) after = Math.max(after, at + 1);
  }
  return Math.max(position, after);
}

/** Where element `id` of `r.obj` was at the heads `r` was deleted at. */
function positionAt(
  be: Backend,
  r: Reinsert,
  id: string,
  ctx: InverseContext
): number | undefined {
  if (r.type === "list") {
    const at = indexOf(
      be,
      r.obj,
      r.type,
      expand(ctx, [id]),
      r.heads,
      ctx.owners
    );
    return at < 0 ? undefined : at;
  }
  // An element that didn't exist yet has no position.
  const created = ctx.created.get(id);
  if (created !== undefined && created >= r.seq) return undefined;
  try {
    return be.getCursorPosition(r.obj, id as A.Cursor, r.heads);
  } catch {
    // A deleted element with nothing visible after it throws once the
    // document has changed since: it is at the end.
    return be.length(r.obj, r.heads);
  }
}

/**
 * The formats the step set or removed, from its changes' `mark` patches,
 * each split into segments by the value it had before the change.
 */
function planFormats(
  be: Backend,
  ops: readonly OpRecord[],
  formatted: Map<string, Map<string, Format["expand"]>>,
  created: Set<string>,
  ctx: InverseContext
): Format[] {
  const out: Format[] = [];
  for (const [hash, expands] of formatted) {
    const record = ops.find((r) => r.hash === hash)!;
    const { deps } = record;
    const patches = be.diff(deps, [hash]);
    // A change's patches apply one after another, each in the coordinates
    // the earlier ones left: map a formatting patch's range back to the
    // text before the change through the splices before it. Characters the
    // change inserted drop out: the inverse removes them anyway.
    const isText = (path: Prop[]) => {
      const o = objectAt(be, path, [hash]);
      return !!o && typeOf(be, o, [hash]) === "text";
    };
    // The formats as the change's earlier marks left them, in the
    // coordinates before the change: a later mark over the same range
    // undoes to that, not to the formats before the whole change.
    const simulated = new Map<
      string,
      Array<{ start: number; end: number; value: unknown }>
    >();
    const spansOf = (obj: string, name: string) => {
      const key = `${obj}|${name}`;
      let spans = simulated.get(key);
      if (!spans) {
        spans = be
          .marks(obj, deps)
          .filter((m) => m.name === name)
          .map(({ start, end, value }) => ({ start, end, value }));
        simulated.set(key, spans);
      }
      return spans;
    };
    for (const [i, patch] of patches.entries()) {
      if (patch.action !== "mark") continue;
      if (ctx.ignore(patch.path)) continue;
      const obj = objectAt(be, patch.path, [hash]);
      if (!obj || created.has(obj)) continue;
      const splices = textSplices(patches.slice(0, i), isText);
      const key = pathKey(patch.path);
      for (const mark of patch.marks) {
        const expand = expands.get(mark.name);
        if (!expand || mark.end <= mark.start) continue;
        const range = mapCharsBack(mark.start, mark.end, splices, key);
        if (!range) continue;
        const [from, to] = range;
        // Split [from, to) where the format's value changed before.
        const all = spansOf(obj, mark.name);
        const spans = all.filter((m) => m.end > from && m.start < to);
        const points = [
          ...new Set([
            from,
            to,
            ...spans
              .flatMap((m) => [m.start, m.end])
              .filter((p) => p > from && p < to),
          ]),
        ].sort((a, b) => a - b);
        const segments: Format["segments"] = [];
        for (let i = 0; i + 1 < points.length; i++) {
          const a = points[i]!;
          const b = points[i + 1]!;
          const prev =
            spans.find((m) => m.start <= a && m.end > a)?.value ?? null;
          const last = segments.at(-1);
          const firstId = be.getCursor(obj, a, deps);
          const lastId = be.getCursor(obj, b - 1, deps);
          if (last && stableJSON(last.prev) === stableJSON(prev)) {
            last.last = lastId;
            last.to = b;
          } else {
            segments.push({
              first: firstId,
              last: lastId,
              prev,
              from: a,
              to: b,
              heads: deps,
            });
          }
        }
        for (const id of segments.flatMap((g) => [g.first, g.last])) {
          if (!ctx.owners.has(id)) ctx.owners.set(id, obj);
        }
        // Apply the mark to the simulation.
        const kept = all.flatMap((m) => {
          if (m.end <= from || m.start >= to) return [m];
          const parts = [];
          if (m.start < from) parts.push({ ...m, end: from });
          if (m.end > to) parts.push({ ...m, start: to });
          return parts;
        });
        if (mark.value !== null && mark.value !== undefined) {
          kept.push({ start: from, end: to, value: mark.value });
        }
        all.splice(0, all.length, ...kept);
        out.push({
          kind: "format",
          order: record.order + out.length / 1e6,
          obj,
          name: mark.name,
          value: mark.value ?? null,
          expand,
          segments,
        });
      }
    }
  }
  return out;
}

/** Restore a format's earlier values, segment by segment. */
function format(
  be: Backend,
  action: Format,
  target: string,
  ctx: InverseContext,
  conflict: ConflictPolicy,
  skipped: Skipped[],
  ownCopies: ReadonlySet<string>
): void {
  const path = pathOf(be, target) ?? [];
  // Where an element of a segment is now: its own (or newest copy's)
  // index, or -1 if gone.
  const find = (id: string): number => {
    const ids = ctx.copies.chain(id).reverse();
    return indexOf(be, target, "text", ids, undefined, ctx.owners, action.obj);
  };
  // Where an end of a segment is now: its element, or, if that is gone, the
  // nearest element inward (at the segment's heads) that is still there; a
  // few are tried, each a lookup at old heads.
  type Segment = Format["segments"][number];
  const locate = (segment: Segment, edge: "start" | "end"): number => {
    const own = find(edge === "start" ? segment.first : segment.last);
    if (own >= 0) return edge === "start" ? own : own + 1;
    const span = segment.to - segment.from;
    for (let k = 1; k < Math.min(span, 32); k++) {
      const i = edge === "start" ? segment.from + k : segment.to - 1 - k;
      const id = be.getCursor(action.obj, i, segment.heads);
      if (!ctx.owners.has(id)) ctx.owners.set(id, action.obj);
      const at = find(id);
      if (at >= 0) return edge === "start" ? at : at + 1;
    }
    return -1;
  };
  for (const segment of action.segments) {
    const start = locate(segment, "start");
    const end = locate(segment, "end");
    // Nothing left between the ends to format.
    if (start < 0 || end <= start) continue;
    // Characters this inverse re-inserted have their own formats back
    // already, and the step never formatted them: leave them out.
    const pieces: Array<[number, number]> = [];
    for (let i = start; i < end; i++) {
      const id = idOf((be.getAll(target, i) as Entry[]).at(-1)!);
      if (ownCopies.has(id)) continue;
      const piece = pieces.at(-1);
      if (piece && piece[1] === i) piece[1] = i + 1;
      else pieces.push([i, i + 1]);
    }
    // Someone else formatted the range since: a conflict, like a value.
    const spans = be.marks(target).filter((m) => m.name === action.name);
    const unchanged = pieces.every(([from, to]) => {
      const current = spans.filter((m) => m.end > from && m.start < to);
      if (action.value === null) return current.length === 0;
      return (
        current.every(
          (m) => stableJSON(m.value) === stableJSON(action.value)
        ) && coversWithoutGaps(current, from, to)
      );
    });
    if (!unchanged && conflict === "skip") {
      skipped.push({ path, reason: "conflict" });
      continue;
    }
    for (const [from, to] of pieces) {
      const range = { start: from, end: to, expand: action.expand };
      if (segment.prev === null) be.unmark(target, range, action.name);
      else be.mark(target, range, action.name, segment.prev as A.ScalarValue);
    }
  }
}

function coversWithoutGaps(
  spans: ReadonlyArray<{ start: number; end: number }>,
  start: number,
  end: number
): boolean {
  let reached = start;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start > reached) return false;
    reached = Math.max(reached, span.end);
  }
  return reached >= end;
}

type RestoredChar = {
  target: string;
  home: string;
  copy: string;
  formats: Record<string, unknown>;
};

/**
 * Give re-inserted characters the formats the deleted ones had: per text
 * and format, one mark (or unmark) per run of adjacent characters missing
 * the same value.
 */
function restoreFormats(
  be: Backend,
  chars: readonly RestoredChar[],
  ctx: InverseContext
): void {
  const byTarget = new Map<string, Array<RestoredChar & { at: number }>>();
  for (const c of chars) {
    const at = indexOf(
      be,
      c.target,
      "text",
      [c.copy],
      undefined,
      ctx.owners,
      c.target
    );
    if (at < 0) continue;
    let list = byTarget.get(c.target);
    if (!list) byTarget.set(c.target, (list = []));
    list.push({ ...c, at });
  }
  for (const [target, list] of byTarget) {
    list.sort((a, b) => a.at - b.at);
    // The text's formats, read once (a read per character costs a lot
    // inside a change); writing one format doesn't change another's.
    const spans = be.marks(target);
    const lo = list[0]!.at;
    const hi = list.at(-1)!.at + 1;
    const names = new Set<string>();
    for (const c of list)
      for (const name of Object.keys(c.formats)) names.add(name);
    for (const m of spans) if (m.end > lo && m.start < hi) names.add(m.name);
    for (const name of names) {
      const ofName = spans.filter(
        (m) => m.name === name && m.end > lo && m.start < hi
      );
      const has = (at: number) =>
        ofName.find((m) => m.start <= at && m.end > at)?.value ?? null;
      let run: { start: number; end: number; want: unknown } | undefined;
      const flush = () => {
        if (!run) return;
        const range = {
          start: run.start,
          end: run.end,
          expand: "none" as const,
        };
        if (run.want === null) be.unmark(target, range, name);
        else be.mark(target, range, name, run.want as A.ScalarValue);
        run = undefined;
      };
      for (const c of list) {
        const want = c.formats[name] ?? null;
        const have = has(c.at);
        if (stableJSON(want) === stableJSON(have)) {
          flush();
          continue;
        }
        if (
          run &&
          run.end === c.at &&
          stableJSON(run.want) === stableJSON(want)
        ) {
          run.end = c.at + 1;
        } else {
          flush();
          run = { start: c.at, end: c.at + 1, want };
        }
      }
      flush();
    }
  }
}
