import type { Patch, Prop } from "@automerge/automerge/slim";

/**
 * Text ranges a change touched, per text object (keyed by its path), used to
 * decide whether a text edit continues the current step (CodeMirror's
 * `isAdjacent`): it does if it touches the range of the step's edits.
 */
export type TextRanges = Map<string, Array<[number, number]>>;

/** One splice of a text, in the coordinates just before it applies. */
export type TextSplice = {
  key: string;
  index: number;
  remove: number;
  insert: number;
};

export function pathKey(path: readonly Prop[]): string {
  return JSON.stringify(path);
}

/**
 * The text splices in `patches`, in order. `isText(path)` says whether the
 * sequence at `path` is a text (lists don't take part in adjacency).
 */
export function textSplices(
  patches: readonly Patch[],
  isText: (path: Prop[]) => boolean
): TextSplice[] {
  const out: TextSplice[] = [];
  for (const patch of patches) {
    const { action } = patch;
    if (action !== "splice" && action !== "del" && action !== "insert")
      continue;
    const index = patch.path[patch.path.length - 1];
    if (typeof index !== "number") continue;
    const parent = patch.path.slice(0, -1);
    // Splices are always text; deletions and insertions (rich text's block
    // markers are objects inserted into it) only count in a text.
    if (action !== "splice" && !isText(parent)) continue;
    out.push({
      key: pathKey(parent),
      index,
      remove: action === "del" ? (patch.length ?? 1) : 0,
      insert:
        action === "splice"
          ? patch.value.length
          : action === "insert"
            ? patch.values.length
            : 0,
    });
  }
  return out;
}

function mapForward(pos: number, s: TextSplice, assoc: -1 | 1): number {
  if (s.remove > 0) {
    if (pos >= s.index + s.remove) pos -= s.remove;
    else if (pos > s.index) pos = s.index;
  }
  if (s.insert > 0 && (pos > s.index || (pos === s.index && assoc > 0))) {
    pos += s.insert;
  }
  return pos;
}

function mapBackward(pos: number, s: TextSplice): number {
  if (s.insert > 0) {
    if (pos >= s.index + s.insert) pos -= s.insert;
    else if (pos > s.index) pos = s.index;
  }
  if (s.remove > 0 && pos > s.index) pos += s.remove;
  return pos;
}

function push(ranges: TextRanges, key: string, range: [number, number]) {
  let list = ranges.get(key);
  if (!list) ranges.set(key, (list = []));
  list.push(range);
}

/** Map every range through `splices`, which apply after them. */
export function mapRanges(
  ranges: TextRanges,
  splices: readonly TextSplice[]
): void {
  for (const s of splices) {
    const list = ranges.get(s.key);
    if (!list) continue;
    for (const range of list) {
      range[0] = mapForward(range[0], s, -1);
      range[1] = mapForward(range[1], s, 1);
    }
  }
}

/**
 * The ranges a change's splices touched, in the coordinates before the
 * change (`before`) and after it (`after`), like the two sides of a
 * CodeMirror `ChangeDesc`.
 */
export function changeRanges(splices: readonly TextSplice[]): {
  before: TextRanges;
  after: TextRanges;
} {
  const before: TextRanges = new Map();
  const after: TextRanges = new Map();
  splices.forEach((s, k) => {
    let from = s.index;
    let to = s.index + s.remove;
    for (let j = k - 1; j >= 0; j--) {
      if (splices[j]!.key !== s.key) continue;
      from = mapBackward(from, splices[j]!);
      to = mapBackward(to, splices[j]!);
    }
    push(before, s.key, [from, to]);

    mapRanges(after, [s]);
    push(after, s.key, [s.index, s.index + s.insert]);
  });
  return { before, after };
}

/** Whether any range in `a` touches (inclusively) a range in `b`. */
export function touches(a: TextRanges, b: TextRanges): boolean {
  for (const [key, list] of b) {
    const other = a.get(key);
    if (!other) continue;
    for (const [from, to] of list) {
      for (const [f, t] of other) if (to >= f && from <= t) return true;
    }
  }
  return false;
}

export function addRanges(into: TextRanges, from: TextRanges): void {
  for (const [key, list] of from) {
    for (const range of list) push(into, key, [range[0], range[1]]);
  }
}

/**
 * The characters `[start, end)` (after `splices`, for the text at `key`)
 * mapped back to before the splices. Characters the splices inserted drop
 * out; undefined if none is left.
 */
export function mapCharsBack(
  start: number,
  end: number,
  splices: readonly TextSplice[],
  key: string
): [number, number] | undefined {
  let first = start;
  let last = end - 1;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i]!;
    if (s.key !== key) continue;
    // Undo the insertion: characters in it drop out.
    if (s.insert > 0) {
      if (first >= s.index + s.insert) first -= s.insert;
      else if (first >= s.index) first = s.index;
      if (last >= s.index + s.insert) last -= s.insert;
      else if (last >= s.index) last = s.index - 1;
    }
    // Undo the deletion: characters at or after it were further on.
    if (s.remove > 0) {
      if (first >= s.index) first += s.remove;
      if (last >= s.index) last += s.remove;
    }
    if (last < first) return undefined;
  }
  return [first, last + 1];
}
