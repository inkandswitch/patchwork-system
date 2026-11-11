import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { asString, setText } from "./text.ts";

const write = (doc: any, path: (string | number)[], value: string) => {
  const heads = A.getHeads(doc).join();
  const next = A.change(doc, (d: any) => setText(d, path, value));
  return { doc: next as any, wrote: A.getHeads(next).join() !== heads };
};

describe("setText", () => {
  it("writes nothing when the text is unchanged", () => {
    const doc = A.from({ docs: [{ name: "Notes" }] });
    expect(write(doc, ["docs", 0, "name"], "Notes").wrote).toBe(false);
  });

  it("writes nothing when an ImmutableString already holds the value", () => {
    const doc = A.from<any>({
      "@patchwork": { title: new A.ImmutableString("Notes") },
    });
    expect(write(doc, ["@patchwork", "title"], "Notes").wrote).toBe(false);
  });

  it("edits text in place when it changed", () => {
    const doc = A.from({ docs: [{ name: "Notes" }] });
    const r = write(doc, ["docs", 0, "name"], "Plans");
    expect(r.wrote).toBe(true);
    expect(r.doc.docs[0].name).toBe("Plans");
  });

  it("replaces an ImmutableString that changed", () => {
    const doc = A.from<any>({ docs: [{ name: new A.ImmutableString("Notes") }] });
    const r = write(doc, ["docs", 0, "name"], "Plans");
    expect(r.wrote).toBe(true);
    expect(asString(r.doc.docs[0].name)).toBe("Plans");
  });

  it("does nothing when the parent is missing", () => {
    const doc = A.from<any>({ docs: [] });
    expect(write(doc, ["docs", 3, "name"], "x").wrote).toBe(false);
  });
});
