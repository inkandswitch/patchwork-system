import { isImmutableString, updateText } from "@automerge/automerge-repo/slim";

// Any string in a doc may be stored as collaborative text or as an
// ImmutableString (pushwork writes them that way); read them the same.
export function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isImmutableString(v)) return String(v);
  return undefined;
}

// Write `value` at `key` of `parent` (inside a change), but only if it differs.
// Collaborative text is diffed in place; anything else (an ImmutableString,
// missing) is replaced outright, since updateText can't edit it. An unchanged
// value writes nothing: assigning even an identical scalar records a change.
export function setText(
  doc: any,
  path: (string | number)[],
  value: string
): void {
  const key = path[path.length - 1];
  let parent = doc;
  for (const p of path.slice(0, -1)) parent = parent?.[p];
  if (parent == null) return;
  const current = parent[key];
  if (asString(current) === value) return;
  if (typeof current === "string") updateText(doc, path, value);
  else parent[key] = value;
}
