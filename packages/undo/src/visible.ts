import * as A from "@automerge/automerge/slim";
import type { Heads, Patch, Prop } from "@automerge/automerge/slim";

/**
 * JSON with object keys sorted. An Automerge document's key order follows
 * the order of its patches, so equal values can stringify differently.
 */
export function stableJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v instanceof Uint8Array) return Array.from(v);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

function at(root: unknown, path: readonly Prop[]): unknown {
  let value = root as Record<string | number, unknown> | undefined;
  for (const prop of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[prop] as Record<string | number, unknown> | undefined;
  }
  return value;
}

/** The object at `path` (a list of props from the root) at `heads`. */
export function objectAt(
  be: ReturnType<typeof A.getBackend>,
  path: readonly Prop[],
  heads?: Heads
): string | undefined {
  let obj = "_root";
  for (const prop of path) {
    const entry = (be.getAll(obj, prop, heads) as unknown[][]).at(-1);
    if (!entry || entry.length !== 2) return undefined;
    obj = entry[1] as string;
  }
  return obj;
}

/**
 * Whether going from `before` to `after` changed anything a user can see:
 * for some patch between them, the value at the patch's path (the sequence,
 * for an index path) differs, or, for a formatting patch, the text's marks. An empty diff is not the criterion: writing
 * an equal value, or re-creating an equal object, produces patches.
 */
export function changedVisibly(
  doc: A.Doc<unknown>,
  before: Heads,
  after: Heads,
  patches: readonly Patch[],
  ignore: (path: Prop[]) => boolean
): boolean {
  if (patches.length === 0) return false;
  const viewBefore = A.view(doc, before);
  const viewAfter = A.view(doc, after);
  const seen = new Set<string>();
  const be = A.getBackend(doc);
  for (const patch of patches) {
    if (ignore(patch.path)) continue;
    // Formatting doesn't show in a text's JSON: compare the marks.
    if (patch.action === "mark" || patch.action === "unmark") {
      const marks = (heads: Heads) => {
        const obj = objectAt(be, patch.path, heads);
        return obj ? stableJSON(be.marks(obj, heads)) : "";
      };
      if (marks(before) !== marks(after)) return true;
      continue;
    }
    let path = patch.path;
    if (typeof path[path.length - 1] === "number") path = path.slice(0, -1);
    const key = JSON.stringify(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (stableJSON(at(viewBefore, path)) !== stableJSON(at(viewAfter, path))) {
      return true;
    }
    // A text's formatting can change without a formatting patch: a
    // character replaced by an equal one with other formats.
    if (typeof at(viewAfter, path) === "string") {
      const marks = (heads: Heads) => {
        const obj = objectAt(be, path, heads);
        return obj ? stableJSON(be.marks(obj, heads)) : "";
      };
      if (marks(before) !== marks(after)) return true;
    }
  }
  return false;
}
