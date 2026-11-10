import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as A from "@automerge/automerge/slim";
import {
  encodeHeads,
  generateAutomergeUrl,
  Repo,
  type DocHandle,
} from "@automerge/automerge-repo/slim";
import { composeMessage, installProvenance } from "../../src/provenance/stamp.js";
import { writerKey } from "../../src/provenance/writer.js";

const ORIGIN = "https://pw.test";
const heads = encodeHeads(A.getHeads(A.from({ a: 1 })));
const ROOT_A = `${generateAutomergeUrl()}#${heads.join("|")}`;
const ROOT_B = `${generateAutomergeUrl()}#${heads.join("|")}`;
const stackFor = (root: string) =>
  `Error\n    at wrapped (${ORIGIN}/assets/index.js:1:1)\n    at onClick (${ORIGIN}/${encodeURIComponent(root)}/dist/index.js:3:9)`;

let current: string | undefined;
let stackSource: () => string | undefined = () => current;
let uninstall: (() => void) | undefined;
let repo: Repo;

function install() {
  uninstall = installProvenance({
    siteOrigin: ORIGIN,
    siteRoot: "site@test",
    httpSources: () => [],
    stack: () => stackSource(),
  });
}

beforeEach(() => {
  current = stackFor(ROOT_A);
  stackSource = () => current;
  repo = new Repo({});
  install();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

type Doc = Record<string, any>;
const make = (init: Doc = { "@patchwork": { type: "test" }, text: "" }) => repo.create<Doc>(init);
const messages = (h: DocHandle<any>) =>
  A.getChangesMetaSince(h.fullDoc(), []).map((c) => c.message);
const count = (h: DocHandle<any>) => A.getChangesMetaSince(h.fullDoc(), []).length;
const writers = (h: DocHandle<any>) => h.fullDoc()["@patchwork"]?.writers;

describe("composeMessage", () => {
  it("is the key alone, or the caller's message and the key on its own line", () => {
    expect(composeMessage(undefined, "4kQx9TmB")).toBe("pw:4kQx9TmB");
    expect(composeMessage("rename layer", "4kQx9TmB")).toBe("rename layer\npw:4kQx9TmB");
  });

  it("puts where the write came from after the key", () => {
    expect(composeMessage("rename layer", "4kQx9TmB", "dist/index.js:3:9")).toBe(
      "rename layer\npw:4kQx9TmB dist/index.js:3:9",
    );
  });
});

describe("installProvenance", () => {
  const KEY_A = writerKey(ROOT_A);
  /** A change stamped from `stackFor(ROOT_A)`: the key, and where in the package it came from. */
  const STAMP_A = `pw:${KEY_A} dist/index.js:3:9`;

  it("stamps a change", () => {
    const h = make();
    h.change((d) => (d.x = 1));
    expect(messages(h)).toContain(`pw:${KEY_A}`);
    expect(messages(h).at(-1)).toBe(`pw:${KEY_A}`);
  });

  it("keeps a caller's message", () => {
    const h = make();
    h.change((d) => (d.x = 1), { message: "rename layer" });
    expect(messages(h)).toContain(`rename layer\n${STAMP_A}`);
  });

  it("records a writer once", () => {
    const h = make();
    const before = count(h);
    h.change((d) => (d.x = 1));
    h.change((d) => (d.x = 2));
    expect(writers(h)).toEqual({ [KEY_A]: { url: ROOT_A } });
    expect(count(h) - before).toBe(3);
  });

  it("records two writers", () => {
    const h = make();
    h.change((d) => (d.x = 1));
    current = stackFor(ROOT_B);
    h.change((d) => (d.x = 2));
    expect(writers(h)).toEqual({
      [KEY_A]: { url: ROOT_A },
      [writerKey(ROOT_B)]: { url: ROOT_B },
    });
  });

  it("value form", () => {
    const h = make();
    h.sub("text").change("hi");
    expect(h.doc().text).toBe("hi");
    expect(messages(h)).toContain(`pw:${KEY_A}`);
    expect(writers(h)).toEqual({ [KEY_A]: { url: ROOT_A } });
  });

  it("changeAt", () => {
    const h = make();
    h.changeAt(h.heads(), (d) => (d.y = 1));
    expect(h.doc().y).toBe(1);
    expect(messages(h)).toContain(`pw:${KEY_A}`);
    expect(writers(h)).toEqual({ [KEY_A]: { url: ROOT_A } });
  });

  it("sub-handle", () => {
    const h = make({ "@patchwork": { type: "test" }, items: {} });
    h.sub("items").change((d: Doc) => (d.a = 1));
    expect(h.doc().items).toEqual({ a: 1 });
    expect(messages(h)).toContain(`pw:${KEY_A}`);
    expect(writers(h)).toEqual({ [KEY_A]: { url: ROOT_A } });
    expect(h.doc().items["@patchwork"]).toBeUndefined();
  });

  it("no @patchwork, one is created", () => {
    const h = make({ text: "" });
    h.change((d) => (d.x = 1));
    expect(messages(h)).toContain(`pw:${KEY_A}`);
    expect(h.doc()["@patchwork"]).toEqual({ writers: { [KEY_A]: { url: ROOT_A } } });
  });

  it("@patchwork not an object", () => {
    const h = make({ "@patchwork": "x" });
    h.change((d) => (d.y = 1));
    expect(messages(h)).toContain(STAMP_A);
    expect(h.doc()["@patchwork"]).toBe("x");
  });

  it("writers not an object", () => {
    const h = make({ "@patchwork": { type: "test", writers: "x" } });
    h.change((d) => (d.y = 1));
    expect(messages(h)).toContain(STAMP_A);
    expect(writers(h)).toBe("x");
  });

  it("a collision grows the key", () => {
    const h = make({ "@patchwork": { type: "test", writers: { [KEY_A]: { url: "other" } } } });
    h.change((d) => (d.y = 1));
    const grown = writerKey(ROOT_A, 9);
    expect(messages(h)).toContain(`pw:${grown}`);
    expect(writers(h)[grown]).toEqual({ url: ROOT_A });
    expect(writers(h)[KEY_A]).toEqual({ url: "other" });
  });

  it("handle identity", async () => {
    uninstall!();
    uninstall = undefined;
    const h = make();
    const before = await repo.find(h.url);
    install();
    expect(await repo.find(h.url)).toBe(before);
    expect(h.sub("x")).toBe(h.sub("x"));
  });

  it("uninstall restores", () => {
    uninstall!();
    uninstall = undefined;
    const h = make();
    h.change((d) => (d.x = 1));
    expect(messages(h).at(-1)).toBeNull();
  });

  it("a second install throws", () => {
    expect(() => install()).toThrow("provenance already installed");
  });

  it("a site-only stack is recorded as the site", () => {
    current = `Error\n    at f (${ORIGIN}/assets/index.js:1:1)`;
    const h = make();
    h.change((d) => (d.x = 1));
    expect(writers(h)).toEqual({ [writerKey("site@test")]: { url: "site@test" } });
  });

  it("a stack with no site or package frame is left unstamped", () => {
    current = "Error\n    at f (https://esm.sh/x.js:1:1)";
    const h = make();
    h.change((d) => (d.x = 1));
    expect(messages(h).at(-1)).toBeNull();
    expect(writers(h)).toBeUndefined();
  });

  // Review Focus

  it("a throwing callback writes no record", () => {
    const h = make();
    const before = count(h);
    const boom = new Error("boom");
    let caught: unknown;
    try {
      h.change(() => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(count(h)).toBe(before);
    expect(writers(h)).toBeUndefined();
    h.change((d) => (d.x = 1));
    expect(messages(h)).toContain(`pw:${KEY_A}`);
  });

  it("an empty change makes no record", () => {
    const h = make();
    const before = count(h);
    h.change(() => {});
    expect(count(h)).toBe(before);
    expect(writers(h)).toBeUndefined();
  });

  it("a fixed-heads handle still throws", () => {
    const h = make();
    const before = count(h);
    expect(() => h.view(h.heads()).change((d: Doc) => (d.x = 1))).toThrow();
    expect(count(h)).toBe(before);
  });

  it("an unreadable stack leaves the change unstamped", () => {
    const limit = Error.stackTraceLimit;
    const h = make();
    stackSource = () => undefined;
    h.change((d) => (d.x = 1));
    expect(messages(h).at(-1)).toBeNull();
    stackSource = () => {
      throw new Error("no stack");
    };
    h.change((d) => (d.x = 2));
    expect(messages(h).at(-1)).toBeNull();
    expect(h.doc().x).toBe(2);
    expect(Error.stackTraceLimit).toBe(limit);
  });

  it("a stack that isn't a string leaves the change unstamped", () => {
    const h = make();
    stackSource = () => [] as unknown as string;
    h.change((d) => (d.x = 1));
    expect(h.doc().x).toBe(1);
    expect(messages(h).at(-1)).toBeNull();
  });

  it("a failure finding the writer leaves the change unstamped", () => {
    uninstall!();
    uninstall = installProvenance({
      siteOrigin: ORIGIN,
      siteRoot: "site@test",
      httpSources: () => {
        throw new Error("registry gone");
      },
      stack: () => stackSource(),
    });
    const h = make();
    h.change((d) => (d.x = 1));
    expect(h.doc().x).toBe(1);
    expect(messages(h).at(-1)).toBeNull();
  });

  it("a sub of a sub made before install writes no record into the subtree", () => {
    uninstall!();
    uninstall = undefined;
    const h = make({ "@patchwork": { type: "test" }, items: { inner: {} } });
    const items = h.sub("items");
    install();
    items.sub("inner").change((d: Doc) => (d.a = 1));
    expect(h.doc().items).toEqual({ inner: { a: 1 } });
    expect(messages(h)).toContain(STAMP_A);
  });

  it("a second copy of the module can't install over the first", async () => {
    vi.resetModules();
    const again = await import("../../src/provenance/stamp.js");
    expect(() =>
      again.installProvenance({ siteOrigin: ORIGIN, siteRoot: "site@test", httpSources: () => [] }),
    ).toThrow("provenance already installed");
  });

  it("nested changes both stamp", () => {
    const a = make();
    const b = make();
    a.change((d) => {
      d.x = 1;
      b.change((e) => (e.x = 1));
    });
    expect(messages(a)).toContain(`pw:${KEY_A}`);
    expect(messages(b)).toContain(`pw:${KEY_A}`);
    expect(writers(a)).toEqual({ [KEY_A]: { url: ROOT_A } });
    expect(writers(b)).toEqual({ [KEY_A]: { url: ROOT_A } });
  });
});

describe("authors", () => {
  const DEVICE = "a1b2c3d4e5f60718".repeat(4);
  const ID = DEVICE.slice(0, 16);
  const CONTACT = generateAutomergeUrl();
  let author: { id: string; device: string; contact?: string } | undefined;

  beforeEach(() => {
    uninstall!();
    author = { id: ID, device: DEVICE, contact: CONTACT };
    uninstall = installProvenance({
      siteOrigin: ORIGIN,
      siteRoot: "site@test",
      httpSources: () => [],
      stack: () => stackSource(),
      author: () => author,
    });
  });

  const metas = (h: DocHandle<any>) => A.getChangesMetaSince(h.fullDoc(), []);

  it("marks every change with the author, and records who that is once, with the writer", () => {
    const h = make();
    const before = count(h);
    h.change((d) => (d.x = 1));
    h.change((d) => (d.x = 2));
    expect(count(h) - before).toBe(3);
    expect(metas(h).slice(before).map((m) => m.author)).toEqual([ID, ID, ID]);
    expect(h.doc()["@patchwork"].authors).toEqual({ [ID]: { device: DEVICE, contact: CONTACT } });
    expect(writers(h)).toEqual({ [writerKey(ROOT_A)]: { url: ROOT_A } });
  });

  it("adds the contact card once it's known", () => {
    author = { id: ID, device: DEVICE };
    const h = make();
    h.change((d) => (d.x = 1));
    expect(h.doc()["@patchwork"].authors).toEqual({ [ID]: { device: DEVICE } });
    author = { id: ID, device: DEVICE, contact: CONTACT };
    const before = count(h);
    h.change((d) => (d.x = 2));
    expect(count(h) - before).toBe(2);
    expect(h.doc()["@patchwork"].authors[ID]).toEqual({ device: DEVICE, contact: CONTACT });
    h.change((d) => (d.x = 3));
    expect(count(h) - before).toBe(3);
  });

  it("ignores an author id that isn't 16 hex characters", () => {
    author = { id: "nope", device: DEVICE };
    const h = make();
    h.change((d) => (d.x = 1));
    expect(metas(h).at(-1)!.author).toBeNull();
    expect(h.doc()["@patchwork"].authors).toBeUndefined();
  });

  it("an author that throws leaves the change stamped, without an author", () => {
    uninstall!();
    uninstall = installProvenance({
      siteOrigin: ORIGIN,
      siteRoot: "site@test",
      httpSources: () => [],
      stack: () => stackSource(),
      author: () => {
        throw new Error("no account yet");
      },
    });
    const h = make();
    h.change((d) => (d.x = 1));
    expect(h.doc().x).toBe(1);
    expect(writers(h)).toEqual({ [writerKey(ROOT_A)]: { url: ROOT_A } });
  });
});

describe("the default stack source", () => {
  it("restores Error.stackTraceLimit", () => {
    uninstall!();
    uninstall = installProvenance({ siteOrigin: ORIGIN, siteRoot: "site@test", httpSources: () => [] });
    const limit = Error.stackTraceLimit;
    make().change((d) => (d.x = 1));
    expect(Error.stackTraceLimit).toBe(limit);
  });
});
