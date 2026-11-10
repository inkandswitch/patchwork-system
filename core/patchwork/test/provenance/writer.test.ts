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

  it("lets a source whose directory is a whole host claim only its own file", () => {
    const cdn = { ...ctx, httpSources: () => ["https://esm.sh/tldraw@3", `${ORIGIN}/tool.js`] };
    expect(packageRoot("https://esm.sh/other@1/x.js", cdn)).toBeUndefined();
    expect(packageRoot("https://esm.sh/tldraw@3", cdn)).toBe("https://esm.sh/tldraw@3");
    expect(packageRoot(`${ORIGIN}/assets/index-abc.js`, cdn)).toBe("site");
    expect(packageRoot(`${ORIGIN}/tool.js`, cdn)).toBe(`${ORIGIN}/tool.js`);
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
    expect(findWriter(stack, ctx)).toEqual({ root: ROOT_A, key: writerKey(ROOT_A), at: "dist/index.js:1:1" });
  });

  it("names the site when only site frames are on the stack", () => {
    const stack = v8(`${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/assets/main.js`);
    expect(findWriter(stack, ctx)).toEqual({
      root: "site@42",
      key: writerKey("site@42"),
      at: "assets/index-abc.js:1:1",
    });
  });

  it("says where in the package the write came from", () => {
    const stack = `Error\n    at onClick (${served(ROOT_A, "dist/assets/canvas-x1.js")}:412:17)`;
    expect(findWriter(stack, ctx)!.at).toBe("dist/assets/canvas-x1.js:412:17");
    const dev = { ...ctx, httpSources: () => ["http://localhost:5173/src/main.tsx"] };
    const devStack = "Error\n    at f (http://localhost:5173/src/components/Draw.tsx?t=123:88:3)";
    expect(findWriter(devStack, dev)).toMatchObject({
      root: "http://localhost:5173/src/main.tsx",
      at: "components/Draw.tsx:88:3",
    });
    const file = { ...ctx, httpSources: () => ["https://esm.sh/tldraw@3"] };
    expect(findWriter("Error\n    at f (https://esm.sh/tldraw@3:5:6)", file)!.at).toBe("tldraw@3:5:6");
  });

  it("reads the plugin sources once per stack", () => {
    let calls = 0;
    const counted = { ...ctx, httpSources: () => (calls++, []) };
    findWriter(v8(...Array.from({ length: 20 }, () => `${ORIGIN}/assets/index-abc.js`)), counted);
    expect(calls).toBe(1);
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
