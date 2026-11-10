import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge/slim";
import { encodeHeads, generateAutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { explain, explainSummary, parseMessage } from "@inkandswitch/patchwork-provenance";
import { installProvenance } from "../../src/provenance/stamp.js";
import { writerKey } from "../../src/provenance/writer.js";

const ORIGIN = "https://pw.test";
const heads = encodeHeads(A.getHeads(A.from({ a: 1 })));
const ROOT_A = `${generateAutomergeUrl()}#${heads.join("|")}`;
const ROOT_B = `${generateAutomergeUrl()}#${heads.join("|")}`;
const KEY_A = writerKey(ROOT_A);
const KEY_B = writerKey(ROOT_B);
const stackFor = (root: string) =>
  `Error\n    at onClick (${ORIGIN}/${encodeURIComponent(root)}/dist/index.js:3:9)`;

let current = stackFor(ROOT_A);
let uninstall: (() => void) | undefined;
let repo: Repo;

beforeEach(() => {
  current = stackFor(ROOT_A);
  repo = new Repo({});
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});
const install = () => {
  uninstall = installProvenance({
    siteOrigin: ORIGIN,
    siteRoot: "site@test",
    httpSources: () => [],
    stack: () => current,
  });
};

describe("parseMessage", () => {
  it("splits the caller's message from the key", () => {
    expect(parseMessage("pw:4kQx9TmB")).toEqual({ message: null, key: "4kQx9TmB", at: null });
    expect(parseMessage("rename layer\npw:4kQx9TmB")).toEqual({ message: "rename layer", key: "4kQx9TmB", at: null });
    expect(parseMessage("pw:4kQx")).toEqual({ message: "pw:4kQx", key: null, at: null });
    expect(parseMessage(null)).toEqual({ message: null, key: null, at: null });
  });
});

describe("explain", () => {
  // One change from before install, three from A (plus A's record), one from B (plus B's record).
  function mixed() {
    const h = repo.create<Record<string, any>>({ "@patchwork": { type: "test" } });
    h.change((d) => (d.before = true));
    install();
    current = stackFor(ROOT_A);
    for (let i = 0; i < 3; i++) h.change((d) => (d.a = i));
    current = stackFor(ROOT_B);
    h.change((d) => (d.b = 1), { message: "from b" });
    return h;
  }

  it("lists changes newest first with their writers", () => {
    const h = mixed();
    const rows = explain(h);
    expect(rows.map((r) => r.key)).toEqual([KEY_B, KEY_B, KEY_A, KEY_A, KEY_A, KEY_A, null, null]);
    expect(rows[0].writer).toEqual({ url: ROOT_B });
    expect(rows[1]).toMatchObject({ message: "from b", key: KEY_B, writer: { url: ROOT_B }, at: "dist/index.js:3:9" });
    // The record change says which writer, not where.
    expect(rows[0]!.at).toBeNull();
    expect(rows[2].writer).toEqual({ url: ROOT_A });
    expect(rows.at(-2)!.writer).toBeNull();
    for (const row of rows) {
      expect(typeof row.hash).toBe("string");
      expect(typeof row.time).toBe("number");
      expect(typeof row.actor).toBe("string");
    }
  });

  it("calls a key with no record unrecorded", () => {
    install();
    const h = repo.create<Record<string, any>>({ "@patchwork": "x" });
    h.change((d) => (d.y = 1));
    expect(explain(h)[0]).toMatchObject({ key: KEY_A, writer: "unrecorded" });
  });

  it("takes limit and since", () => {
    const h = mixed();
    expect(explain(h, { limit: 2 })).toHaveLength(2);
    const all = explain(h, { limit: Infinity });
    const first = all.at(-1)!;
    const since = explain(h, { since: [first.hash], limit: Infinity });
    expect(since).toHaveLength(all.length - 1);
    expect(since.map((r) => r.hash)).not.toContain(first.hash);
  });

  it("reads the whole doc through a sub-handle", () => {
    const h = mixed();
    h.change((d) => (d.items = {}));
    expect(explain(h.sub("items"), { limit: Infinity })).toHaveLength(explain(h, { limit: Infinity }).length);
  });
});

describe("authors", () => {
  it("reads back who made each change, from the author and its record", () => {
    const device = "0123456789abcdef".repeat(4);
    const contact = generateAutomergeUrl();
    uninstall = installProvenance({
      siteOrigin: ORIGIN,
      siteRoot: "site@test",
      httpSources: () => [],
      stack: () => current,
      author: () => ({ id: device.slice(0, 16), device, contact }),
    });
    const h = repo.create<Record<string, any>>({ "@patchwork": { type: "test" } });
    h.change((d) => (d.a = 1));
    const [record, change] = explain(h);
    expect(change).toMatchObject({ key: KEY_A, author: device.slice(0, 16), person: { device, contact } });
    expect(record!.person).toEqual({ device, contact });
    expect(explain(h).at(-1)).toMatchObject({ author: null, person: null });
  });
});

describe("explainSummary", () => {
  it("groups the whole history by writer, most changes first", () => {
    const h = repo.create<Record<string, any>>({ "@patchwork": { type: "test" } });
    h.change((d) => (d.before = true));
    install();
    for (let i = 0; i < 60; i++) h.change((d) => (d.a = i));
    const rows = explainSummary(h);
    expect(rows[0]).toMatchObject({ key: KEY_A, writer: { url: ROOT_A }, count: 61 });
    expect(rows[0].first).toBeLessThanOrEqual(rows[0].last);
    const unkeyed = rows.find((r) => r.key === null)!;
    expect(unkeyed).toMatchObject({ writer: null, count: 2 });
  });
});
