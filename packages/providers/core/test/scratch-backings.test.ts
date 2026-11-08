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

let repo: Repo;
let scratch: Repo;
let note: DocHandle<Note>;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  repo = new Repo();
  scratch = new Repo();
  note = repo.create<Note>({ title: "note" });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.replaceChildren();
});

// A fork of `of` made in `into`, the way a remapper computing a view would.
function forkInto<T>(into: Repo, of: DocHandle<T>): DocHandle<T> {
  const fork = into.create<T>();
  fork.update(() => A.clone(of.doc()));
  return fork;
}

// remapper > consumer. The remapper answers `note`'s descriptor with whatever
// it was last told to, and claims every scratch lease, counting them.
function mount(options: { scratchRepo?: Repo } = { scratchRepo: scratch }) {
  const remapperEl = document.createElement("div");
  const consumer = document.createElement("div");
  remapperEl.append(consumer);
  document.body.append(remapperEl);

  let current: DocHandleDescriptor = { url: note.url };
  const responders = new Set<(d: DocHandleDescriptor) => void>();
  const held = new Map<AutomergeUrl, number>();
  const log: string[] = [];
  const released: ((url: AutomergeUrl) => void)[] = [];

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
        held.set(url, (held.get(url) ?? 0) + 1);
        log.push(`hold ${url}`);
        return () => {
          held.set(url, held.get(url)! - 1);
          log.push(`release ${url}`);
          for (const fn of released) fn(url);
        };
      });
    }
  });

  const overlay = new OverlayRepo(repo, consumer, options);
  teardowns.push(() => overlay.dispose());
  return {
    overlay,
    log,
    leases: (url: AutomergeUrl) => held.get(url) ?? 0,
    answer(descriptor: DocHandleDescriptor) {
      current = descriptor;
      for (const respond of responders) respond(descriptor);
    },
    onRelease(fn: (url: AutomergeUrl) => void) {
      released.push(fn);
    },
  };
}

describe("scratch backings", () => {
  it("finds a scratch backing in the scratch repo, under the original url", async () => {
    const fork = forkInto(scratch, note);
    fork.change((d) => {
      d.title = "laid";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: fork.url });

    const handle = await view.overlay.find<Note>(note.url);
    expect(handle.url).toBe(note.url);
    expect(handle.doc().title).toBe("laid");

    handle.change((d) => {
      d.title = "edited";
    });
    expect(fork.doc().title).toBe("edited");
    expect(note.doc().title).toBe("note");
    expect(repo.handles[fork.documentId]).toBeUndefined();
  });

  it("holds a lease on the scratch document while it backs the view", async () => {
    const fork = forkInto(scratch, note);
    const view = mount();
    view.answer({ url: note.url, scratchUrl: fork.url });
    const handle = await view.overlay.find<Note>(note.url);
    await vi.waitFor(() => expect(view.leases(fork.url)).toBe(1));

    view.answer({ url: note.url });
    await vi.waitFor(() => expect(view.leases(fork.url)).toBe(0));
    note.change((d) => {
      d.title = "live";
    });
    expect(handle.doc().title).toBe("live");
  });

  it("takes the new lease before letting the old one go", async () => {
    const first = forkInto(scratch, note);
    const second = forkInto(scratch, note);
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
    const first = forkInto(scratch, note);
    const view = mount();
    view.onRelease((url) => scratch.delete(url));
    view.answer({ url: note.url, scratchUrl: first.url });
    const handle = await view.overlay.find<Note>(note.url);
    const deleted = vi.fn();
    handle.on("delete", deleted);

    view.answer({ url: note.url });
    await vi.waitFor(() => expect(view.leases(first.url)).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleted).not.toHaveBeenCalled();
    expect(handle.doc().title).toBe("note");
  });

  it("lets its leases go on dispose", async () => {
    const fork = forkInto(scratch, note);
    const view = mount();
    view.answer({ url: note.url, scratchUrl: fork.url });
    await view.overlay.find<Note>(note.url);
    await vi.waitFor(() => expect(view.leases(fork.url)).toBe(1));

    view.overlay.dispose();
    await vi.waitFor(() => expect(view.leases(fork.url)).toBe(0));
  });

  it("holds no lease for a backing in the realm repo", async () => {
    const clone = repo.clone(note);
    const view = mount();
    view.answer({ url: note.url, cloneUrl: clone.url });
    await view.overlay.find<Note>(note.url);
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.log).toEqual([]);

    view.answer({ url: note.url, cloneUrl: clone.url, scratchUrl: computed.url });
    await vi.waitFor(() => expect(handle.doc().title).toBe("laid"));
  });

  it("defaults to the realm's scratch repo", async () => {
    expect(getScratchRepo()).toBe(getScratchRepo());
    const fork = forkInto(getScratchRepo(), note);
    fork.change((d) => {
      d.title = "laid";
    });
    const view = mount({});
    view.answer({ url: note.url, scratchUrl: fork.url });
    const handle = await view.overlay.find<Note>(note.url);
    expect(handle.doc().title).toBe("laid");
  });
});
