// The router in node: a fake window, location and root element, a real
// in-memory Repo, and an account whose / holds Projects/foo/notes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { livePath } from "@inkandswitch/patchwork-filesystem";

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

/** A location whose hash reads back with its "#", as a browser's does. */
function fakeLocation(initial: string) {
  let hash = initial;
  return {
    get hash() {
      return hash ? `#${hash}` : "";
    },
    set hash(value: string) {
      hash = value.replace(/^#/, "");
    },
  };
}

async function setup(hash: (a: string, notes: AutomergeUrl) => string) {
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
  const root = folder({ Projects: folder({ foo: folder({ notes: notes.url }).url }).url });
  const account = repo.create({
    "@patchwork": { type: "account" },
    namespace: { "/": [{ url: root.url }] },
  });
  const a = await idhash(account.documentId);

  const location = fakeLocation(hash(a, notes.url));
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location, addEventListener() {} });
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
  return { a, live, notes, other, location, rootElement, opened, router };
}

const hashParam = (location: { hash: string }, key: string) =>
  new RegExp(`(?:^|[#&])${key}=([^&]*)`).exec(location.hash)?.[1];

// A document this repo doesn't have, for a doc= the path disagrees with.
const OTHER = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ";

afterEach(() => vi.unstubAllGlobals());

describe("router: path=", () => {
  it("writes an opened document's path to the hash", async () => {
    const { live, notes, location, rootElement } = await setup(() => "");
    rootElement.dispatchEvent(
      new CustomEvent("patchwork:open-document", { detail: { url: notes.url, path: live } })
    );
    expect(hashParam(location, "doc")).toBe(notes.url);
    expect(hashParam(location, "path")).toBe(live);
  });

  it("drops path from the hash when a document is opened without one", async () => {
    const { other, location, rootElement } = await setup(
      (_, n) => `doc=${n}&path=${livePath("x", ["y"])}`
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
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({ url: notes.url, path: live });
    expect(hashParam(location, "doc")).toBe(notes.url);
  });

  it("warns and drops a path that names nothing, opening nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { opened, location } = await setup((a) => `path=${livePath(a, ["nope"])}`);
    await vi.waitFor(() => expect(hashParam(location, "path")).toBeUndefined());
    expect(opened).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
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
