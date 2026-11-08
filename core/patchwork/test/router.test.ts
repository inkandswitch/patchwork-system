// @vitest-environment happy-dom
//
// The router keeps the root view and the tab's title in step with the hash.
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRouter } from "../src/router.js";

const SITE = "Site";
type Note = { "@patchwork": { type: string }; title: string };

getRegistry("patchwork:datatype").register(
  {
    type: "patchwork:datatype",
    id: "router-test-note",
    name: "Note",
    load: async () => ({
      init() {},
      getTitle: (doc: Note) => doc.title,
    }),
  } as any,
  "router-test"
);

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// hashchange is dispatched on a timer, so let it land before going on.
const go = async (hash: string) => {
  location.hash = hash;
  await ticks();
};

let repo: Repo;
let root: HTMLElement;
let account: AutomergeUrl;
// Lookups for these urls wait until the test lets them through.
let held: Map<AutomergeUrl, Promise<void>>;
const listeners: [string, EventListenerOrEventListenerObject][] = [];

function note(title: string): AutomergeUrl {
  return repo.create<Note>({
    "@patchwork": { type: "router-test-note" },
    title,
  }).url;
}

function hold(url: AutomergeUrl): () => void {
  let release!: () => void;
  held.set(url, new Promise<void>((resolve) => (release = resolve)));
  return release;
}

function start() {
  const lookups = {
    async find(url: AutomergeUrl) {
      await held.get(url);
      return repo.find(url);
    },
  };
  const router = createRouter({
    rootElement: root,
    repo: lookups as any,
    accountDocHandle: { url: account, doc: () => ({}) } as any,
    siteTitle: SITE,
    frameToolId: "home-frame",
  });
  // The frame has mounted: from here on the router opens the hash's document.
  void router.route();
  return router;
}

function open(url: AutomergeUrl) {
  root.dispatchEvent(
    new CustomEvent("patchwork:open-document", { detail: { url } })
  );
}

beforeEach(async () => {
  await go("");
  document.title = SITE;
  repo = new Repo();
  account = repo.create({}).url;
  held = new Map();
  root = document.createElement("div");
  document.body.append(root);
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: any, options?: any) => {
      listeners.push([type, listener]);
      add(type, listener, options);
    }
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [type, listener] of listeners.splice(0)) {
    window.removeEventListener(type, listener);
  }
  root.remove();
  await repo.shutdown();
});

describe("the tab's title", () => {
  it("names the document that was opened", async () => {
    start();
    open(note("Apples"));
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
  });

  it("isn't taken by a slower lookup for a document opened earlier", async () => {
    start();
    const apples = note("Apples");
    const pears = note("Pears");
    const releaseApples = hold(apples);
    open(apples);
    await ticks();
    open(pears);
    await vi.waitFor(() => expect(document.title).toBe(`Pears | ${SITE}`));
    releaseApples();
    await ticks(20);
    expect(document.title).toBe(`Pears | ${SITE}`);
  });

  it("doesn't keep naming the previous document while the next one loads", async () => {
    start();
    open(note("Apples"));
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
    const pears = note("Pears");
    hold(pears);
    open(pears);
    await ticks();
    expect(document.title).toBe(SITE);
  });

  it("follows a rename", async () => {
    start();
    const apples = note("Apples");
    open(apples);
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
    (await repo.find<Note>(apples)).change((doc) => {
      doc.title = "Crab apples";
    });
    await vi.waitFor(() =>
      expect(document.title).toBe(`Crab apples | ${SITE}`)
    );
  });

  it("stops following a document once another is open", async () => {
    start();
    const apples = note("Apples");
    open(apples);
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
    open(note("Pears"));
    await vi.waitFor(() => expect(document.title).toBe(`Pears | ${SITE}`));
    (await repo.find<Note>(apples)).change((doc) => {
      doc.title = "Crab apples";
    });
    await ticks(20);
    expect(document.title).toBe(`Pears | ${SITE}`);
  });

  it("goes back to the site's name when no document is open", async () => {
    start();
    open(note("Apples"));
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
    await go("");
    await vi.waitFor(() => expect(document.title).toBe(SITE));
  });
});

describe("the root view", () => {
  it("goes back to the home frame when the hash names no frame", async () => {
    const pears = note("Pears");
    await go(`frame=other-frame&doc=${pears}`);
    start();
    expect(root.getAttribute("tool-id")).toBe("other-frame");
    expect(root.getAttribute("doc-url")).toBe(pears);
    await go(`doc=${pears}`);
    expect(root.getAttribute("tool-id")).toBe("home-frame");
    expect(root.getAttribute("doc-url")).toBe(account);
  });

  it("rewrites a bare automerge url to a doc= link", async () => {
    start();
    const apples = note("Apples");
    await go(apples);
    await vi.waitFor(() => expect(location.hash).toBe(`#doc=${apples}`));
    await vi.waitFor(() => expect(document.title).toBe(`Apples | ${SITE}`));
  });
});
