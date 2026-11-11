import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import {
  ADD_TO_SIDEBAR_EVENT,
  handleAddToSidebar,
  putAtTop,
  type DocLink,
} from "./addToSidebar";

beforeAll(() => initSubduction());

const link = (id: string, name = id.toUpperCase()): DocLink => ({
  url: `automerge:${id}` as AutomergeUrl,
  name,
  type: "t",
});

describe("putAtTop", () => {
  it("adds a new doc first", () => {
    const folder = { docs: [link("a")] };
    putAtTop(folder, link("b"));
    expect(folder.docs.map((d) => d.name)).toEqual(["B", "A"]);
  });

  it("lifts a doc that's already there, keeping its name", () => {
    const folder = { docs: [link("a"), link("b", "kept")] };
    putAtTop(folder, link("b"));
    expect(folder.docs).toEqual([link("b", "kept"), link("a")]);
  });
});

describe("handleAddToSidebar", () => {
  it("claims the event and puts the doc at the top of the root folder", async () => {
    const repo = new Repo();
    const root = repo.create<{ docs: DocLink[] }>({ docs: [link("a")] });
    const account = repo.create<{ rootFolderUrl?: AutomergeUrl }>({});
    const frame = document.createElement("div");
    const child = document.createElement("span");
    frame.appendChild(child);
    const stop = handleAddToSidebar(frame, repo, account);

    let work: Promise<unknown> | undefined;
    const event = new CustomEvent(ADD_TO_SIDEBAR_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: {
        url: "automerge:new",
        name: "New",
        type: "essay",
        respondWith: (p: Promise<unknown>) => (work = p),
      },
    });
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // the account only learns its root folder later; the add waits for it
    account.change((doc) => {
      doc.rootFolderUrl = root.url;
    });
    await work;

    expect(root.doc()!.docs.map((d) => d.url)).toEqual([
      "automerge:new",
      "automerge:a",
    ]);
    stop();
  });
});
