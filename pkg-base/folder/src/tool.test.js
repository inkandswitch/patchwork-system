import { describe, expect, it, vi } from "vitest";
import { generateAutomergeUrl, ImmutableString } from "@automerge/automerge-repo";

vi.mock("@inkandswitch/patchwork-elements", () => ({ openDocument() {} }));
vi.mock("@inkandswitch/patchwork-plugins", () => ({
  getRegistry: () => ({ all: () => [] }),
  createDocOfDatatype2() {},
}));
vi.mock("./styles.css", () => ({ default: "" }));

const { FolderTool } = await import("./tool.js");

function fakeHandle(doc) {
  return { url: generateAutomergeUrl(), doc: () => doc, on() {}, off() {} };
}

const names = (element) =>
  [...element.querySelectorAll(".folder-entry-name")].map((n) => n.textContent);

describe("FolderTool", () => {
  it("shows a folder whose links are ImmutableStrings", () => {
    const url = generateAutomergeUrl();
    const element = document.createElement("div");
    FolderTool(
      fakeHandle({
        title: "pushwork",
        docs: [{ name: new ImmutableString("a.ts"), type: new ImmutableString("ts"), url: new ImmutableString(url) }],
      }),
      element
    );
    expect(names(element)).toEqual(["a.ts"]);
    expect(element.querySelector("patchwork-view").getAttribute("doc-url")).toBe(url);
  });

  it("walks a pushwork directory doc", () => {
    const element = document.createElement("div");
    FolderTool(
      fakeHandle({
        "@patchwork": { type: "directory", title: "repo" },
        "README.md": new ImmutableString(generateAutomergeUrl()),
        "src/index.js": new ImmutableString(generateAutomergeUrl()),
      }),
      element
    );
    expect(names(element)).toEqual(["src", "README.md"]);
    expect(element.querySelector(".folder-create").hidden).toBe(true);

    element.querySelector("button.folder-entry-open").click();
    expect(names(element)).toEqual(["index.js"]);

    element.querySelector("button.folder-view-crumb").click();
    expect(names(element)).toEqual(["src", "README.md"]);
  });
});
