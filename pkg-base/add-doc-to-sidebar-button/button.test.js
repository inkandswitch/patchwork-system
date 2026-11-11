import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo, initSubduction } from "@automerge/automerge-repo";

beforeAll(() => initSubduction());

vi.mock("@inkandswitch/patchwork-plugins", () => ({
  getRegistry: () => ({
    get: () => ({ module: { getTitle: (doc) => doc.title } }),
    load: () => Promise.resolve(),
  }),
}));

const { default: render, putAtTop, ADD_TO_SIDEBAR_EVENT } = await import(
  "./button.js"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("putAtTop", () => {
  const a = { url: "automerge:a", name: "A", type: "t" };
  const b = { url: "automerge:b", name: "B", type: "t" };

  it("adds a new doc first", () => {
    const folder = { docs: [a] };
    putAtTop(folder, b);
    expect(folder.docs.map((d) => d.url)).toEqual([b.url, a.url]);
  });

  it("lifts a doc that's already there instead of adding it twice", () => {
    const folder = { docs: [a, { ...b, name: "kept" }] };
    putAtTop(folder, b);
    expect(folder.docs).toEqual([{ ...b, name: "kept" }, a]);
  });

  it("makes the list if the folder has none", () => {
    const folder = {};
    putAtTop(folder, a);
    expect(folder.docs).toEqual([a]);
  });
});

describe("the button", () => {
  let repo, doc, root, account, host, cleanup;

  beforeEach(() => {
    repo = new Repo();
    root = repo.create({ docs: [{ url: "automerge:x", name: "X", type: "t" }] });
    account = repo.create({ rootFolderUrl: root.url });
    doc = repo.create({ "@patchwork": { type: "essay" }, title: "My essay" });
    host = document.createElement("patchwork-view");
    host.setAttribute("doc-url", doc.url);
    document.body.appendChild(host);
    window.repo = repo;
    window.accountDocHandle = account;
    cleanup = render(doc, host);
  });

  afterEach(() => {
    cleanup();
    host.remove();
    delete window.repo;
    delete window.accountDocHandle;
  });

  const click = () => host.querySelector("button").click();

  it("lets a frame that claims the event do the adding", async () => {
    const seen = [];
    let done;
    const claim = (event) => {
      event.preventDefault();
      seen.push({ ...event.detail });
      event.detail.respondWith(new Promise((resolve) => (done = resolve)));
    };
    document.body.addEventListener(ADD_TO_SIDEBAR_EVENT, claim);
    click();
    document.body.removeEventListener(ADD_TO_SIDEBAR_EVENT, claim);

    expect(seen[0]).toMatchObject({
      url: doc.url,
      name: "My essay",
      type: "essay",
    });
    done();
    await flush();
    expect(host.querySelector("button").textContent).toBe("Added ✓");
    expect(root.doc().docs).toHaveLength(1);
  });

  it("adds to the top of the root folder itself when nobody claims it", async () => {
    click();
    await flush();
    await flush();
    expect(root.doc().docs.map((d) => d.url)).toEqual([doc.url, "automerge:x"]);
    expect(root.doc().docs[0]).toEqual({
      url: doc.url,
      name: "My essay",
      type: "essay",
    });
  });

  it("finds the account on window.patchwork when that's all there is", async () => {
    delete window.accountDocHandle;
    window.patchwork = { account, repo };
    try {
      click();
      await flush();
      await flush();
      expect(root.doc().docs[0].url).toBe(doc.url);
    } finally {
      delete window.patchwork;
    }
  });
});
