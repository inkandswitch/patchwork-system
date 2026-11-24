import { describe, expect, it } from "vitest";
import {
  commonOutdir,
  entriesFromExports,
  entryOutputs,
} from "../src/entries.js";

describe("entriesFromExports", () => {
  it("takes every export with a source, and skips plain files", () => {
    const entries = entriesFromExports({
      ".": { import: "./dist/main.js", source: "./src/main.ts" },
      "./tool": { import: "./dist/tool.js", source: "./src/tool.tsx" },
      "./style.css": "./dist/index.css",
      "./prebuilt": { import: "./dist/prebuilt.js" },
    });
    expect(entries).toEqual([
      { in: "./src/main.ts", import: "./dist/main.js" },
      { in: "./src/tool.tsx", import: "./dist/tool.js" },
    ]);
  });

  it("reads a bare conditions object as the `.` export", () => {
    expect(
      entriesFromExports({
        import: "./dist/index.js",
        source: "./src/index.ts",
      })
    ).toEqual([{ in: "./src/index.ts", import: "./dist/index.js" }]);
  });

  it("finds nothing in a string or missing exports", () => {
    expect(entriesFromExports("./dist/index.js")).toEqual([]);
    expect(entriesFromExports(undefined)).toEqual([]);
  });
});

describe("commonOutdir", () => {
  it("is the directory the imports share", () => {
    expect(
      commonOutdir([
        { in: "a", import: "./dist/main.js" },
        { in: "b", import: "./dist/extensions/links.js" },
      ])
    ).toBe("dist");
    expect(
      commonOutdir([
        { in: "a", import: "./dist/a/x.js" },
        { in: "b", import: "./dist/a/y/z.js" },
      ])
    ).toBe("dist/a");
  });

  it("is nothing when the imports share no directory", () => {
    expect(commonOutdir([{ in: "a", import: "./index.js" }])).toBeUndefined();
    expect(commonOutdir([{ in: "a" }])).toBeUndefined();
  });
});

describe("entryOutputs", () => {
  it("writes each source where its import says", () => {
    expect(
      entryOutputs(
        [
          { in: "./src/main.ts", import: "./dist/main.js" },
          {
            in: "./src/lib/codemirror.tsx",
            import: "./dist/lib/codemirror.js",
          },
          { in: "./src/sideboard/x.tsx", import: "./dist/elsewhere.js" },
          { in: "./src/loose.ts" },
        ],
        "dist"
      )
    ).toEqual([
      { in: "./src/main.ts", out: "main" },
      { in: "./src/lib/codemirror.tsx", out: "lib/codemirror" },
      { in: "./src/sideboard/x.tsx", out: "elsewhere" },
      { in: "./src/loose.ts", out: "loose" },
    ]);
  });

  it("refuses an import outside the outdir", () => {
    expect(() =>
      entryOutputs([{ in: "./src/a.ts", import: "./lib/a.js" }], "dist")
    ).toThrow(/outside the outdir/);
  });

  it("refuses an import that isn't .js", () => {
    expect(() =>
      entryOutputs([{ in: "./src/a.ts", import: "./dist/a.mjs" }], "dist")
    ).toThrow(/has to end in .js/);
  });
});
