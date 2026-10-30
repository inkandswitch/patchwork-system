import { describe, expect, it } from "vitest";
import { parseHashParams, serializeHashParams } from "../src/hash-params.js";

describe("hash params", () => {
  it("keeps a path's segments as they're encoded", () => {
    const hash = "doc=automerge:abc&path=acct/a%2Fb/x%26y/%23z/my%20notes/1%2B1";
    expect(parseHashParams(hash).get("path")).toBe(
      "acct/a%2Fb/x%26y/%23z/my%20notes/1%2B1"
    );
    expect(serializeHashParams(parseHashParams(hash))).toBe(hash);
  });

  it("puts path right after doc", () => {
    const params = new URLSearchParams({ tool: "t", doc: "automerge:abc" });
    params.set("path", "acct/x");
    expect(serializeHashParams(params)).toBe("doc=automerge:abc&path=acct/x&tool=t");
  });

  it("reads a hash with no path as before", () => {
    const params = parseHashParams("doc=automerge:abc&title=a%20b");
    expect(params.get("title")).toBe("a b");
    expect(params.has("path")).toBe(false);
  });
});
