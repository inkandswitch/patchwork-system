// What one change did to a doc, as rows a person can read: each path it
// touched, with what was there before and what it put there.
import * as A from "@automerge/automerge/slim";

export type DiffKind = "set" | "delete" | "text" | "insert" | "remove" | "inc" | "mark";

export type DiffRow = {
  /** Where, written like code: `layers[3].name`. */
  path: string;
  kind: DiffKind;
  /** What was there before, shown short; for text, the characters removed. */
  before?: string;
  /** What's there after, shown short; for text, the characters added. */
  after?: string;
  /** Anything else: a mark's name and range, how much a counter moved. */
  note?: string;
};

const IDENT = /^[A-Za-z_$@][\w$@-]*$/;

export function formatPath(path: readonly A.Prop[]): string {
  let out = "";
  for (const prop of path) {
    if (typeof prop === "number") out += `[${prop}]`;
    else if (IDENT.test(prop)) out += out ? `.${prop}` : prop;
    else out += `[${JSON.stringify(prop)}]`;
  }
  return out || "(root)";
}

const MAX = 48;
const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);

/** A value, shown short. */
export function preview(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(clip(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  if (A.isImmutableString(value)) return JSON.stringify(clip(String(value)));
  if (A.isCounter?.(value)) return String((value as { value: number }).value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length} items]`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 0 ? "{}" : `{${keys.length === 1 ? keys[0] : `${keys.length} keys`}}`;
  }
  return String(value);
}

function at(doc: unknown, path: readonly A.Prop[]): unknown {
  let node: any = doc;
  for (const prop of path) {
    if (node === null || node === undefined) return undefined;
    node = node[prop as any];
  }
  return node;
}

/** The part of `before` that became the part of `after`: both without their common prefix and suffix. */
function region(before: string, after: string): { before: string; after: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return { before: before.slice(start, before.length - end), after: after.slice(start, after.length - end) };
}

const isText = (value: unknown) => typeof value === "string" || A.isImmutableString(value);

/**
 * What the change `hash` did, made on top of `deps`. Edits to one text field
 * are one row, the stretch of text that changed; past `limit` rows the rest
 * are dropped and the last row says how many.
 */
export function changeDiff(
  doc: A.Doc<unknown>,
  change: { hash: string; deps: string[] },
  limit = 24,
): DiffRow[] {
  const patches = A.diff(doc, change.deps, [change.hash]);
  const before = A.view(doc, change.deps);
  const after = A.view(doc, [change.hash]);
  const rows: DiffRow[] = [];
  /** Rows filled in once every patch is read: text fields, and strings set whole. */
  const pending = new Map<string, { row: DiffRow; path: A.Prop[]; whole: boolean }>();

  for (const patch of patches) {
    const parent = patch.path.slice(0, -1);
    const last = patch.path.at(-1)!;
    switch (patch.action) {
      case "splice": {
        const key = formatPath(parent);
        if (!pending.has(key)) {
          const row: DiffRow = { path: key, kind: "text" };
          pending.set(key, { row, path: parent, whole: false });
          rows.push(row);
        }
        break;
      }
      case "del": {
        const length = patch.length ?? 1;
        const container = at(before, parent);
        if (isText(container)) {
          const key = formatPath(parent);
          if (!pending.has(key)) {
            const row: DiffRow = { path: key, kind: "text" };
            pending.set(key, { row, path: parent, whole: false });
            rows.push(row);
          }
        } else if (Array.isArray(container)) {
          const index = last as number;
          const removed = container.slice(index, index + length);
          rows.push({
            path: formatPath(patch.path),
            kind: "remove",
            before: removed.length === 1 ? preview(removed[0]) : `${removed.length} items`,
          });
        } else {
          rows.push({ path: formatPath(patch.path), kind: "delete", before: preview(at(before, patch.path)) });
        }
        break;
      }
      case "put": {
        const old = at(before, patch.path);
        const row: DiffRow = {
          path: formatPath(patch.path),
          kind: "set",
          ...(old === undefined ? {} : { before: preview(old) }),
          after: preview(patch.value),
        };
        rows.push(row);
        // A string is put empty and then spliced into; show what it ended up as.
        if (patch.value === "") pending.set(row.path, { row, path: patch.path, whole: true });
        break;
      }
      case "insert":
        rows.push({
          path: formatPath(patch.path),
          kind: "insert",
          after: patch.values.length === 1 ? preview(patch.values[0]) : `${patch.values.length} items`,
        });
        break;
      case "inc":
        rows.push({ path: formatPath(patch.path), kind: "inc", note: patch.value < 0 ? `${patch.value}` : `+${patch.value}` });
        break;
      case "mark":
        for (const mark of patch.marks) {
          rows.push({
            path: formatPath(patch.path),
            kind: "mark",
            note: `${mark.name} ${mark.value === null ? "off" : preview(mark.value)} on ${mark.start}–${mark.end}`,
          });
        }
        break;
      case "unmark":
        rows.push({ path: formatPath(patch.path), kind: "mark", note: `${patch.name} off on ${patch.start}–${patch.end}` });
        break;
    }
  }

  for (const { row, path, whole } of pending.values()) {
    const now = at(after, path);
    if (whole) {
      row.after = preview(now);
      continue;
    }
    const changed = region(String(at(before, path) ?? ""), String(now ?? ""));
    if (changed.before) row.before = clip(changed.before);
    if (changed.after) row.after = clip(changed.after);
  }

  if (rows.length > limit) {
    const rest = rows.length - limit + 1;
    return [...rows.slice(0, limit - 1), { path: "", kind: "set", note: `and ${rest} more` }];
  }
  return rows;
}
