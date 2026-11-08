import { next as A } from "@automerge/automerge";
import {
  Repo,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OverlayRepo,
  accept,
  getScratchRepo,
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "../src/index.js";

type Note = { title: string };

const scratch = getScratchRepo();
let repo: Repo;
let note: DocHandle<Note>;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  repo = new Repo();
  note = repo.create<Note>({ title: "note" });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.replaceChildren();
});

// A fork of `note` in the scratch repo, the way a remapper computing a view
// would make one.
function fork(): DocHandle<Note> {
  const handle = scratch.create<Note>();
  handle.update(() => A.clone(note.doc()));
  return handle;
}

// remapper > consumer. The remapper answers `note`'s descriptor with whatever
// it was last told to, and claims every scratch lease, logging each hold and
// release.
function mount({ onRelease }: { onRelease?: (url: AutomergeUrl) => void } = {}) {
  const remapperEl = document.createElement("div");
  const consumer = document.createElement("div");
  remapperEl.append(consumer);
  document.body.append(remapperEl);

  let current: DocHandleDescriptor = { url: note.url };
  const responders = new Set<(d: DocHandleDescriptor) => void>();
  const log: string[] = [];
  const count = (entry: string) => log.filter((e) => e === entry).length;

  remapperEl.addEventListener("patchwork:subscribe", (event: SubscribeEvent) => {
    const { selector } = event.detail;
    if (selector.type === "repo:handle-descriptor" && selector.url === note.url) {
      accept<DocHandleDescriptor>(event, (respond) => {
        responders.add(respond);
        respond(current);
        return () => responders.delete(respond);
      });
    } else if (selector.type === "repo:scratch-lease") {
      const url = selector.url as AutomergeUrl;
      accept(event, () => {
        log.push(`hold ${url}`);
        return () => {
          log.push(`release ${url}`);
          onRelease?.(url);
        };
      });
    }
  });

  const overlay = new OverlayRepo(repo, consumer);
  teardowns.push(() => overlay.dispose());
  return {
    overlay,
    log,
    leases: (url: AutomergeUrl) => count(`hold ${url}`) - count(`release ${url}`),
    answer(descriptor: DocHandleDescriptor) {
      current = descriptor;
      for (const respond of responders) respond(descriptor);
    },
  };
}

describe("scratch backings", () => {
  it("finds a scratch backing in the scratch repo, under the original url", async () => {
    const scratchDoc = fork();
    scratchDoc.change((d) => {
      d.title = "laid";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });

    const handle = await view.overlay.find<Note>(note.url);
    expect(handle.url).toBe(note.url);
    expect(handle.doc().title).toBe("laid");

    handle.change((d) => {
      d.title = "edited";
    });
    expect(scratchDoc.doc().title).toBe("edited");
    expect(note.doc().title).toBe("note");
    expect(repo.handles[scratchDoc.documentId]).toBeUndefined();
  });

  it("holds a lease on the scratch document while it backs the view", async () => {
    const scratchDoc = fork();
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    expect(view.leases(scratchDoc.url)).toBe(1);

    view.answer({ url: note.url });
    await vi.waitFor(() => expect(view.leases(scratchDoc.url)).toBe(0));
    note.change((d) => {
      d.title = "live";
    });
    expect(handle.doc().title).toBe("live");
  });

  it("takes the new lease before letting the old one go", async () => {
    const first = fork();
    const second = fork();
    second.change((d) => {
      d.title = "second";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: first.url });
    const handle = await view.overlay.find<Note>(note.url);

    view.answer({ url: note.url, scratchUrl: second.url });
    await vi.waitFor(() => expect(view.leases(first.url)).toBe(0));
    expect(handle.doc().title).toBe("second");
    expect(view.leases(second.url)).toBe(1);
    expect(view.log.indexOf(`hold ${second.url}`)).toBeLessThan(
      view.log.indexOf(`release ${first.url}`)
    );
  });

  it("doesn't tell the view about a released scratch document being deleted", async () => {
    const scratchDoc = fork();
    const view = mount({ onRelease: (url) => scratch.delete(url) });
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    const deleted = vi.fn();
    handle.on("delete", deleted);

    view.answer({ url: note.url });
    await vi.waitFor(() => expect(view.leases(scratchDoc.url)).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleted).not.toHaveBeenCalled();
    expect(handle.doc().title).toBe("note");
  });

  it("lets its leases go on dispose", async () => {
    const scratchDoc = fork();
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    await view.overlay.find<Note>(note.url);
    expect(view.leases(scratchDoc.url)).toBe(1);

    view.overlay.dispose();
    await vi.waitFor(() => expect(view.leases(scratchDoc.url)).toBe(0));
  });

  it("holds no lease for a backing in the realm repo", async () => {
    const clone = repo.clone(note);
    const view = mount();
    view.answer({ url: note.url, cloneUrl: clone.url });
    await view.overlay.find<Note>(note.url);
    expect(view.log).toEqual([]);
  });

  it("shows a pinned url from the stored document, not the scratch one", async () => {
    const pinned = stringifyAutomergeUrl({
      documentId: note.documentId,
      heads: note.heads(),
    });
    // Computed, so it shares none of the note's history.
    const computed = scratch.create<Note>({ title: "laid" });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: computed.url });

    const live = await view.overlay.find<Note>(note.url);
    const old = await view.overlay.find<Note>(pinned);
    expect(live.doc().title).toBe("laid");
    expect(old.url).toBe(pinned);
    expect(old.doc().title).toBe("note");
  });

  it("shows a cloneUrl pinned to heads, not the scratch one", async () => {
    const clone = repo.clone(note);
    const checkpoint = stringifyAutomergeUrl({
      documentId: clone.documentId,
      heads: clone.heads(),
    });
    clone.change((d) => {
      d.title = "since";
    });
    const computed = scratch.create<Note>({ title: "laid" });
    const view = mount();
    view.answer({
      url: note.url,
      cloneUrl: checkpoint,
      scratchUrl: computed.url,
    });
    const handle = await view.overlay.find<Note>(note.url);
    expect(handle.doc().title).toBe("note");
    expect(view.log).toEqual([]);

    view.answer({ url: note.url, cloneUrl: clone.url, scratchUrl: computed.url });
    await vi.waitFor(() => expect(handle.doc().title).toBe("laid"));
  });
});
