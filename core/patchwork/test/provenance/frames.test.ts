import { describe, expect, it } from "vitest";
import { frameUrls } from "../../src/provenance/frames.js";

const SITE = "https://pw.test/assets/index-abc.js";
const PKG = "https://pw.test/automerge%3A2jaGJcuHPpLmFzRxxyAQ4kZPQ5mu%237hZ5RYdE/dist/index.js";
const SOLID = "https://pw.test/assets/solid.js";

describe("frameUrls", () => {
  it("reads v8 stacks", () => {
    const stack = `Error\n    at wrapped (${SITE}:10:5)\n    at onClick (${PKG}:3:9)\n    at ${SOLID}:1:1`;
    expect(frameUrls(stack)).toEqual([SITE, PKG, SOLID]);
  });

  it("reads spidermonkey and javascriptcore stacks", () => {
    const stack = `wrapped@${SITE}:10:5\nonClick@${PKG}:3:9\n@${SOLID}:1:1`;
    expect(frameUrls(stack)).toEqual([SITE, PKG, SOLID]);
  });

  it("leaves out frames with no url", () => {
    const v8 = `Error\n    at wrapped (${SITE}:10:5)\n    at new Promise (<anonymous>)\n    at onClick (${PKG}:3:9)`;
    expect(frameUrls(v8)).toEqual([SITE, PKG]);
    const jsc = `wrapped@${SITE}:10:5\nforEach@[native code]\nonClick@${PKG}:3:9`;
    expect(frameUrls(jsc)).toEqual([SITE, PKG]);
  });

  it("keeps an @ inside a url", () => {
    const url = "https://pw.test/@/alice/tools/draw/dist/index.js";
    expect(frameUrls(`Error\n    at f (${url}:1:2)`)).toEqual([url]);
    expect(frameUrls(`f@${url}:1:2`)).toEqual([url]);
  });

  it("gives nothing for an empty stack", () => {
    expect(frameUrls("")).toEqual([]);
  });
});
