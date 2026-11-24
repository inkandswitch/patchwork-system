import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge/slim";
import { changeDiff, formatPath, preview } from "../src/index.js";

/** The diff of the last change `fn` makes to `doc`. */
function last<T>(doc: A.Doc<T>, fn: (d: T) => void) {
  doc = A.clone(doc);
  const next = A.change(doc, fn);
  const meta = A.getChangesMetaSince(next, A.getHeads(doc));
  expect(meta).toHaveLength(1);
  return changeDiff(next, meta[0]!);
}

describe("formatPath", () => {
  it("writes a path like code", () => {
    expect(formatPath(["layers", 3, "name"])).toBe("layers[3].name");
    expect(formatPath(["@patchwork", "writers"])).toBe("@patchwork.writers");
    expect(formatPath(["a b"])).toBe('["a b"]');
    expect(formatPath([])).toBe("(root)");
  });
});

describe("preview", () => {
  it("shows values short", () => {
    expect(preview("x".repeat(100))).toHaveLength(50);
    expect(preview([1, 2])).toBe("[2 items]");
    expect(preview({ a: 1 })).toBe("{a}");
    expect(preview({ a: 1, b: 2 })).toBe("{2 keys}");
    expect(preview(undefined)).toBe("nothing");
  });
});

describe("changeDiff", () => {
  const base = A.from<any>({ layers: [{ name: "Layer 1" }, { name: "Ink" }], text: "hello world", n: 1, gone: true });

  it("shows a set with what it replaced", () => {
    expect(last(base, (d) => (d.layers[0].name = "Background"))).toEqual([
      { path: "layers[0].name", kind: "set", before: '"Layer 1"', after: '"Background"' },
    ]);
    expect(last(base, (d) => (d.fresh = 2))).toEqual([{ path: "fresh", kind: "set", after: "2" }]);
  });

  it("shows a delete with what was there", () => {
    expect(last(base, (d) => delete d.gone)).toEqual([{ path: "gone", kind: "delete", before: "true" }]);
  });

  it("joins a typed run of text into one row", () => {
    expect(last(base, (d) => A.splice(d, ["text"], 5, 0, ", there"))).toEqual([
      { path: "text", kind: "text", after: ", there" },
    ]);
    expect(last(base, (d) => A.splice(d, ["text"], 0, 6))).toEqual([
      { path: "text", kind: "text", before: "hello " },
    ]);
    expect(last(base, (d) => A.updateText(d, ["text"], "hello there"))).toEqual([
      { path: "text", kind: "text", before: "world", after: "there" },
    ]);
  });

  it("shows list inserts and removals", () => {
    expect(last(base, (d) => d.layers.push({ name: "New" }))).toEqual([
      expect.objectContaining({ path: "layers[2]", kind: "insert" }),
      expect.objectContaining({ path: "layers[2].name", kind: "set", after: '"New"' }),
    ]);
    expect(last(base, (d) => d.layers.splice(1, 1))).toEqual([
      { path: "layers[1]", kind: "remove", before: "{name}" },
    ]);
  });

  it("shows the first change of a doc", () => {
    const meta = A.getChangesMetaSince(base, [])[0]!;
    const rows = changeDiff(base, meta);
    expect(rows.map((r) => r.path)).toContain("text");
  });

  it("stops at the limit and says how many more", () => {
    const rows = changeDiff(
      ...(() => {
        const next = A.change(A.clone(base), (d: any) => {
          for (let i = 0; i < 30; i++) d[`k${i}`] = i;
        });
        return [next, A.getChangesMetaSince(next, A.getHeads(base))[0]!] as const;
      })(),
      10,
    );
    expect(rows).toHaveLength(10);
    expect(rows.at(-1)!.note).toBe("and 21 more");
  });
});
