import { describe, expect, it } from "vitest";
import { packageDisplayName } from "./pkg-meta.ts";

describe("packageDisplayName", () => {
  it("prefers title, then name", () => {
    expect(packageDisplayName("automerge:x", { title: "My Tool", name: "@p/x" })).toBe(
      "My Tool"
    );
    expect(packageDisplayName("automerge:x", { name: "@p/x" })).toBe("@p/x");
  });
  it("shortens an automerge url", () => {
    expect(
      packageDisplayName("automerge:3psiCwUeZNMFrmtiAkX75Jvy1tED", undefined)
    ).toBe("automerge:3psiCwUe…");
  });
  it.each([
    ["https://tools.example/cache-browser/index.js", "cache-browser"],
    ["https://tools.example/cache-browser/", "cache-browser"],
    [
      "https://patchwork-base.netlify.app/packages/comments-view/dist/index.js",
      "comments-view",
    ],
    ["https://x.example/tools/contact/dist/tool.js", "contact"],
  ])("names %s after its folder, skipping build dirs", (url, name) => {
    expect(packageDisplayName(url, undefined)).toBe(name);
  });
  it("uses a bare specifier as-is, and says when there's no url", () => {
    expect(packageDisplayName("@patchwork/file", undefined)).toBe("@patchwork/file");
    expect(packageDisplayName(undefined, undefined)).toBe("(unknown source)");
  });
});
