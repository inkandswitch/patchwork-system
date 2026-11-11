import { describe, it, expect } from "vitest";
import { transferablesIn, ALLOWED_PROVIDERS } from "./providers-bridge.js";

describe("transferablesIn", () => {
  it("finds the stream pair a worker provider answers with", () => {
    const readable = new ReadableStream();
    const writable = new WritableStream();
    const found = transferablesIn({ readable, writable });
    expect(found).toHaveLength(2);
    expect(found).toContain(readable);
    expect(found).toContain(writable);
  });

  it("returns nothing for values that clone fine", () => {
    expect(transferablesIn("automerge:abc")).toEqual([]);
    expect(transferablesIn(["automerge:abc", "automerge:def"])).toEqual([]);
    expect(transferablesIn({ url: "automerge:abc", heads: [] })).toEqual([]);
    expect(transferablesIn(null)).toEqual([]);
    expect(transferablesIn(undefined)).toEqual([]);
    expect(transferablesIn(42)).toEqual([]);
  });

  it("does not recurse into nested objects", () => {
    const nested = { inner: { readable: new ReadableStream() } };
    expect(transferablesIn(nested)).toEqual([]);
  });

  it("picks up ports and buffers too", () => {
    const { port1 } = new MessageChannel();
    const buffer = new ArrayBuffer(8);
    expect(transferablesIn({ port: port1, buffer })).toHaveLength(2);
  });
});

describe("ALLOWED_PROVIDERS", () => {
  it("includes the worker channel", () => {
    expect(ALLOWED_PROVIDERS).toContain("patchwork:worker-channel");
  });
});
