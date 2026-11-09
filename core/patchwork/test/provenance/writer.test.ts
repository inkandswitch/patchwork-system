import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge/slim";
import { encodeHeads, generateAutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  findWriter,
  packageRoot,
  writerKey,
  type WriterContext,
} from "../../src/provenance/writer.js";

const ORIGIN = "https://pw.test";
const ctx: WriterContext = {
  siteOrigin: ORIGIN,
  siteRoot: "site@42",
  httpSources: () => [],
};

const heads = encodeHeads(A.getHeads(A.from({ a: 1 })));
const ROOT_A = `${generateAutomergeUrl()}#${heads.join("|")}`;
const ROOT_B = `${generateAutomergeUrl()}#${heads.join("|")}`;
const served = (root: string, file = "dist/index.js") =>
  `${ORIGIN}/${encodeURIComponent(root)}/${file}`;

const v8 = (...urls: string[]) =>
  ["Error", ...urls.map((u, i) => `    at f${i} (${u}:1:1)`)].join("\n");

describe("packageRoot", () => {
  it("decodes the automerge segment of a served package, heads kept", () => {
    expect(packageRoot(served(ROOT_A), ctx)).toBe(ROOT_A);
  });

  it("finds the http source a dev server frame belongs to", () => {
    const dev = { ...ctx, httpSources: () => ["http://localhost:5173/src/main.tsx"] };
    expect(packageRoot("http://localhost:5173/src/components/Draw.tsx", dev)).toBe(
      "http://localhost:5173/src/main.tsx",
    );
  });

  it("takes the longest matching source directory", () => {
    const dev = {
      ...ctx,
      httpSources: () => ["http://localhost:5173/main.js", "http://localhost:5173/tools/draw/main.js"],
    };
    expect(packageRoot("http://localhost:5173/tools/draw/canvas.js", dev)).toBe(
      "http://localhost:5173/tools/draw/main.js",
    );
    expect(packageRoot("http://localhost:5173/lib/x.js", dev)).toBe("http://localhost:5173/main.js");
  });

  it("calls a frame on the site's origin the site", () => {
    expect(packageRoot(`${ORIGIN}/assets/index-abc.js`, ctx)).toBe("site");
  });

  it("skips a frame on another origin", () => {
    expect(packageRoot("https://esm.sh/x.js", ctx)).toBeUndefined();
  });
});

describe("findWriter", () => {
  it("takes the first package frame, skipping site frames above it", () => {
    const stack = v8(`${ORIGIN}/assets/index-abc.js`, served(ROOT_A), `${ORIGIN}/assets/solid.js`);
    expect(findWriter(stack, ctx)).toEqual({ root: ROOT_A, key: writerKey(ROOT_A) });
  });

  it("names the site when only site frames are on the stack", () => {
    const stack = v8(`${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/assets/main.js`);
    expect(findWriter(stack, ctx)).toEqual({ root: "site@42", key: writerKey("site@42") });
  });

  it("finds no writer when no frame is the site's or a package's", () => {
    expect(findWriter(v8("https://esm.sh/x.js", "https://esm.sh/y.js"), ctx)).toBeNull();
  });
});

describe("writerKey", () => {
  it("is 8 base58 characters, stable, and different per root", () => {
    expect(writerKey(ROOT_A)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
    expect(writerKey(ROOT_A)).toBe(writerKey(ROOT_A));
    expect(writerKey(ROOT_A)).not.toBe(writerKey(ROOT_B));
  });

  it("grows by extending the same key", () => {
    expect(writerKey(ROOT_A, 9)).toHaveLength(9);
    expect(writerKey(ROOT_A, 9).startsWith(writerKey(ROOT_A))).toBe(true);
  });
});
