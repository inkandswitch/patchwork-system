import { describe, expect, it } from "vitest";
import { addedBy, groupTools, packageName } from "../group.js";

const pkg = (key, ...by) => ({
  key,
  packageJson: { name: key },
  addedBy: by.map((b) => ({ by: b })),
});

describe("groupTools", () => {
  it("one group per id, tools made for the type first, then by name", () => {
    const groups = groupTools(
      [
        { id: "raw", name: "Raw", supportedDatatypes: "*" },
        { id: "md", name: "Markdown", supportedDatatypes: ["markdown"] },
        { id: "b", name: "Board", supportedDatatypes: ["markdown"] },
        { id: "hidden", name: "Hidden", supportedDatatypes: "*", unlisted: true },
        { id: "bar", name: "Bar", supportedDatatypes: "*", forTitleBar: true },
      ],
      "markdown",
      () => undefined
    );
    expect(groups.map((g) => g.id)).toEqual(["b", "md", "raw"]);
  });

  it("lists every package with an id, the one that opens first", () => {
    const listed = { id: "md", name: "Markdown", supportedDatatypes: ["markdown"], package: pkg("a") };
    const viewed = { id: "md", name: "Markdown (dev)", supportedDatatypes: ["markdown"], package: pkg("b") };
    const [group] = groupTools([listed, viewed], "markdown", () => viewed);
    expect(group.copies).toEqual([viewed, listed]);
    expect(group.name).toBe("Markdown (dev)");
  });
});

describe("packageName and addedBy", () => {
  it("prefer a title, and name each kind of adder once", () => {
    expect(packageName({ key: "k", packageJson: { title: "T", name: "n" } })).toBe("T");
    expect(packageName({ key: "k" })).toBe("k");
    expect(addedBy(pkg("k", "package-list", "package-list", "suggested"))).toBe(
      "package list, suggested"
    );
  });
});
