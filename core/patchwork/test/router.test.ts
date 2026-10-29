// The router in node: a fake window, location and root element, a real
// in-memory Repo, and an account whose / holds Projects/foo/notes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { livePath } from "@inkandswitch/patchwork-filesystem";
import { registerPlugins, unregisterPlugins } from "@inkandswitch/patchwork-plugins";

vi.mock("@inkandswitch/patchwork-elements", () => ({
  openDocument: (element: EventTarget, url: string) =>
    element.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url } })),
}));

const { createRouter } = await import("../src/router.js");
const { idhash } = await import("@inkandswitch/patchwork-filesystem");

class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
}

/**
 * A window whose location's hash reads back with its "#", and which fires
 * hashchange (after the current task) only when the hash really changes, as a
 * browser does.
 */
function fakeWindow(initial: string) {
  let hash = initial;
  const target = new EventTarget();
  const location = {
    get hash() {
      return hash ? `#${hash}` : "";
    },
    set hash(value: string) {
      const next = value.replace(/^#/, "");
      if (next === hash) return;
      hash = next;
      setTimeout(() => target.dispatchEvent(new Event("hashchange")));
    },
  };
  const window = {
    location,
    addEventListener: (type: string, listener: EventListener) =>
      target.addEventListener(type, listener),
  };
  return { window, location };
}

async function setup(
  hash: (a: string, notes: AutomergeUrl) => string,
  extra: (repo: Repo) => Record<string, AutomergeUrl> = () => ({})
) {
  const repo = new Repo();
  const file = (content: string) =>
    repo.create({ "@patchwork": { type: "file" }, content, mimeType: "text/plain" });
  const folder = (entries: Record<string, AutomergeUrl>) =>
    repo.create({
      title: "folder",
      docs: Object.entries(entries).map(([name, url]) => ({ name, type: "x", url })),
    });
  const notes = file("hi");
  const other = file("other");
  const root = folder({
    Projects: folder({ foo: folder({ notes: notes.url }).url }).url,
    ...extra(repo),
  });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }] },
  });
  const a = await idhash(account.documentId);

  const { window, location } = fakeWindow(hash(a, notes.url));
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", { title: "" });

  const rootElement = new FakeElement();
  rootElement.setAttribute("tool-id", "frame");
  const opened: Array<{ url: string; path?: string }> = [];
  rootElement.addEventListener("patchwork:open-document", (event) =>
    opened.push((event as CustomEvent).detail)
  );
  const router = createRouter({
    rootElement: rootElement as unknown as HTMLElement,
    repo,
    accountDocHandle: account as unknown as DocHandle<any>,
    siteTitle: "test",
  });
  const live = livePath(a, ["Projects", "foo", "notes"]);
  return { a, repo, live, notes, other, location, rootElement, opened, router };
}

const hashParam = (location: { hash: string }, key: string) =>
  new RegExp(`(?:^|[#&])${key}=([^&]*)`).exec(location.hash)?.[1];

// A document this repo doesn't have, for a doc= the path disagrees with.
const OTHER = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ";

/** Let the router's background work (path walks, hashchanges) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

afterEach(async () => {
  await settle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("router: path=", () => {
  it("writes an opened document's path to the hash", async () => {
    const { live, notes, location, rootElement } = await setup(() => "");
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: notes.url, path: live } })
    );
    expect(hashParam(location, "doc")).toBe(notes.url);
    expect(hashParam(location, "path")).toBe(live);
  });

  it("drops path from the hash when another document is opened without one", async () => {
    const { live, notes, other, location, rootElement } = await setup(() => "");
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: notes.url, path: live } })
    );
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: other.url } })
    );
    expect(hashParam(location, "path")).toBeUndefined();
  });

  it("opens what a path names when the hash has no doc", async () => {
    const { live, notes, opened, location } = await setup((a) =>
      `path=${livePath(a, ["Projects", "foo", "notes"])}`
    );
    await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(1));
    expect(opened[0]).toMatchObject({ url: notes.url, path: live });
    expect(hashParam(location, "doc")).toBe(notes.url);
  });

  it("keeps path when the same document is opened without one, as on a tool switch", async () => {
    const { live, notes, location, rootElement } = await setup(() => "");
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: notes.url, path: live } })
    );
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: notes.url, toolId: "other" } })
    );
    expect(hashParam(location, "path")).toBe(live);
    expect(hashParam(location, "tool")).toBe("other");
  });

  it("warns about a path that names nothing, opens nothing, and leaves the hash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { a, opened, location } = await setup((a) => `path=${livePath(a, ["nope"])}`);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await settle();
    expect(opened).toHaveLength(0);
    expect(hashParam(location, "path")).toBe(livePath(a, ["nope"]));
  });

  it("keeps a path beside doc when the path can't be resolved", async () => {
    const { a, location } = await setup((a, n) => `doc=${n}&path=${livePath(a, ["nope"])}`);
    await settle();
    expect(hashParam(location, "path")).toBe(livePath(a, ["nope"]));
  });

  it("doesn't open a path's document after the hash has moved on", async () => {
    const { notes, opened, location } = await setup(
      (a) => `path=${livePath(a, ["Projects", "foo", "notes"])}`
    );
    // a click lands while the path is still being walked
    location.hash = `doc=${OTHER}`;
    await settle();
    expect(opened.map((o) => o.url)).not.toContain(notes.url);
  });

  it("settles after opening from a path alone: doc= and path= stay, nothing loops", async () => {
    const { live, notes, opened, location } = await setup(
      (a) => `path=${livePath(a, ["Projects", "foo", "notes"])}`
    );
    await vi.waitFor(() => expect(hashParam(location, "doc")).toBe(notes.url));
    await settle();
    const settledHash = location.hash;
    const count = opened.length;
    await settle();
    expect(location.hash).toBe(settledHash);
    expect(opened.length).toBe(count);
    expect(hashParam(location, "path")).toBe(live);
    // the open, then the hashchange it caused: no more than that
    expect(count).toBeLessThanOrEqual(2);
  });

  it("keeps a path that agrees with doc, opening once", async () => {
    const { live, opened, location, notes } = await setup(
      (a, n) => `doc=${n}&path=${livePath(a, ["Projects", "foo", "notes"])}`
    );
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ url: notes.url, path: live });
    expect(hashParam(location, "path")).toBe(live);
  });

  it("drops a path that disagrees with doc, keeping doc", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { other, location } = await setup(
      (a) => `doc=${OTHER}&path=${livePath(a, ["Projects", "foo", "notes"])}`
    );
    void other;
    await vi.waitFor(() => expect(hashParam(location, "path")).toBeUndefined());
    expect(hashParam(location, "doc")).toBe(OTHER);
    expect(warn).toHaveBeenCalled();
  });
});

describe("router: paths through package providers", () => {
  const PLUGIN_URL = "https://example.test/board.js";
  const board = {
    kind: "board",
    matches: (doc: any) => doc?.["@patchwork"]?.type === "board",
    list: (doc: any) => [
      { name: "child", link: doc.child },
      { name: "notes", sub: ["notes"] },
    ],
    lookup(doc: any, names: string[]) {
      const child = board.list(doc).find((c) => c.name === names[0]);
      return child && { child, consumed: 1 };
    },
  };
  let b: DocHandle<any> | undefined;
  const withBoard = (repo: Repo) => {
    const child = repo.create({ "@patchwork": { type: "file" }, content: "c", mimeType: "text/plain" });
    b = repo.create({
      "@patchwork": { type: "board" },
      child: child.url,
      notes: { content: "n", mimeType: "text/plain" },
    });
    return { b: b.url };
  };

  afterEach(() => unregisterPlugins(PLUGIN_URL));
  const register = () =>
    registerPlugins(
      [{ id: "board", name: "board", type: "patchwork:path-provider", supportedDatatypes: ["board"], load: async () => board }],
      PLUGIN_URL
    );

  it("opens a document a package's provider names", async () => {
    register();
    const { opened } = await setup((a) => `path=${livePath(a, ["b", "child"])}`, withBoard);
    await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(1));
    expect(opened[0].url).toBe(b!.doc().child);
  });

  it("opens a sub-document at its sub-handle's url", async () => {
    register();
    const { opened } = await setup((a) => `path=${livePath(a, ["b", "notes"])}`, withBoard);
    await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(1));
    expect(opened[0].url).toBe(b!.sub("notes").url);
  });
});
