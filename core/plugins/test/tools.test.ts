import { describe, expect, it } from "vitest";
import { getRegistry, registerPlugins } from "../src/registry/index.js";
import {
  getFallbackTool,
  getSupportedToolsForType,
  globMatch,
  opensAnything,
  toolMatch,
  toolSupports,
  type ToolDescription,
} from "../src/tools.js";

const file = (mimeType: string) => ({
  "@patchwork": { type: "file" },
  content: "",
  mimeType,
});

const files = (mimeType: string) => ({
  supports: [{ datatype: "file", where: { mimeType } }],
});

describe("globMatch", () => {
  it("matches literally", () => {
    expect(globMatch("text/markdown", "text/markdown")).toBe(true);
    expect(globMatch("text/markdown", "text/plain")).toBe(false);
    expect(globMatch("text/markdown", "Text/Markdown")).toBe(false);
  });

  it("takes * as any run within a segment", () => {
    expect(globMatch("image/*", "image/png")).toBe(true);
    expect(globMatch("*/*", "image/png")).toBe(true);
    expect(globMatch("text/*", "text/x/y")).toBe(false);
    expect(globMatch("*.md", "notes.md")).toBe(true);
    expect(globMatch("*", "a/b")).toBe(false);
  });

  it("treats regex characters as literal", () => {
    expect(globMatch("image/svg+xml", "image/svg+xml")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});

describe("toolSupports", () => {
  it("joins supportedDatatypes and supports", () => {
    expect(
      toolSupports({
        supportedDatatypes: ["a"],
        supports: [{ datatype: "file", where: { mimeType: "image/*" } }],
      })
    ).toEqual([
      { datatype: "a" },
      { datatype: "file", where: { mimeType: "image/*" } },
    ]);
    expect(toolSupports({ supportedDatatypes: "*" })).toEqual([
      { datatype: "*" },
    ]);
  });

  it("leaves out malformed entries", () => {
    expect(
      toolSupports({
        supports: [
          null,
          { datatype: 4 },
          { datatype: "file", where: { mimeType: 4 } },
          { datatype: "file", where: "image/*" },
        ] as any,
      })
    ).toEqual([]);
  });
});

describe("toolMatch", () => {
  const md = file("text/markdown");

  it("matches an exact field", () => {
    expect(toolMatch(files("text/markdown"), md)).toBe("exact");
  });

  it("matches a field glob", () => {
    expect(toolMatch(files("text/*"), md)).toBe("glob");
  });

  it("takes a pattern of only * and / as saying nothing", () => {
    expect(toolMatch(files("*/*"), md)).toBe("datatype");
    expect(
      toolMatch(
        { supports: [{ datatype: "*", where: { mimeType: "*/*" } }] },
        md
      )
    ).toBe("wildcard");
  });

  it("needs the field to be there", () => {
    expect(toolMatch(files("*/*"), { "@patchwork": { type: "file" } })).toBe(
      undefined
    );
  });

  it("takes the best claim", () => {
    expect(
      toolMatch({ supportedDatatypes: ["file"], ...files("image/png") }, md)
    ).toBe("datatype");
    expect(
      toolMatch({ supportedDatatypes: "*", ...files("text/markdown") }, md)
    ).toBe("exact");
    expect(toolMatch({ supportedDatatypes: "*" }, md)).toBe("wildcard");
  });

  it("doesn't match other values or datatypes", () => {
    expect(toolMatch(files("image/*"), md)).toBeUndefined();
    expect(
      toolMatch(
        { supports: [{ datatype: "other", where: { mimeType: "text/*" } }] },
        md
      )
    ).toBeUndefined();
  });

  it("matches nothing on a doc with no type", () => {
    expect(toolMatch({ supportedDatatypes: "*" }, {})).toBeUndefined();
  });
});

describe("opensAnything", () => {
  it("is a * datatype with no where", () => {
    expect(opensAnything({ supportedDatatypes: "*" })).toBe(true);
    expect(opensAnything({ supports: [{ datatype: "*" }] })).toBe(true);
    expect(opensAnything(files("*/*"))).toBe(false);
    expect(
      opensAnything({
        supports: [{ datatype: "*", where: { mimeType: "*/*" } }],
      })
    ).toBe(false);
    expect(
      opensAnything({
        supports: [{ datatype: "*", where: { mimeType: "text/*" } }],
      })
    ).toBe(false);
  });
});

describe("registry lookups", () => {
  const tool = (id: string, rest: Partial<ToolDescription>) =>
    ({
      type: "patchwork:tool",
      id,
      name: id,
      load: async () => () => () => {},
      ...rest,
    }) as any;

  it("prefers exact, then glob, then datatype, then wildcard", () => {
    const url = "https://example.com/where-fallback/index.js";
    const registry = getRegistry("patchwork:tool");
    const tools = [
      tool("a-raw", { supportedDatatypes: "*" }),
      tool("b-file", { supportedDatatypes: ["file"] }),
      tool("c-text", files("text/*")),
      tool("d-md", files("text/markdown")),
    ];
    registerPlugins(tools, url);
    try {
      expect(getFallbackTool(file("text/markdown"))?.id).toBe("d-md");
      expect(getFallbackTool(file("text/plain"))?.id).toBe("c-text");
      expect(getFallbackTool(file("image/png"))?.id).toBe("b-file");
      expect(getFallbackTool({ "@patchwork": { type: "counter" } })?.id).toBe(
        "a-raw"
      );
      // A `where` narrows a tool to some files, so it isn't one for all.
      expect(
        getSupportedToolsForType("file")
          .map((t) => t.id)
          .sort()
      ).toEqual(["a-raw", "b-file"]);
    } finally {
      for (const t of tools) registry.remove(t.id);
    }
  });
});
