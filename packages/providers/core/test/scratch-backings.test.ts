import { next as A } from "@automerge/automerge";
import {
  Repo,
  generateAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type PeerId,
} from "@automerge/automerge-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OverlayRepo,
  accept,
  getScratchRepo,
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "../src/index.js";
import { backedBy } from "./harness.js";

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
function mount({
  onRelease,
}: { onRelease?: (url: AutomergeUrl) => void } = {}) {
  const remapperEl = document.createElement("div");
  const consumer = document.createElement("div");
  remapperEl.append(consumer);
  document.body.append(remapperEl);

  let current: DocHandleDescriptor = { url: note.url };
  const responders = new Set<(d: DocHandleDescriptor) => void>();
  const log: string[] = [];
  const count = (entry: string) => log.filter((e) => e === entry).length;

  remapperEl.addEventListener(
    "patchwork:subscribe",
    (event: SubscribeEvent) => {
      const { selector } = event.detail;
      if (
        selector.type === "repo:handle-descriptor" &&
        selector.url === note.url
      ) {
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
    }
  );

  const overlay = new OverlayRepo(repo, consumer);
  teardowns.push(() => overlay.dispose());
  return {
    overlay,
    log,
    leases: (url: AutomergeUrl) =>
      count(`hold ${url}`) - count(`release ${url}`),
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

  it("lets a lease go on dispose while its lookup is still pending", async () => {
    const scratchDoc = fork();
    const view = mount();
    const find = vi
      .spyOn(scratch, "find")
      .mockReturnValueOnce(new Promise(() => {}));
    teardowns.push(() => find.mockRestore());
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const found = view.overlay.find<Note>(note.url);
    await vi.waitFor(() => expect(view.leases(scratchDoc.url)).toBe(1));

    view.overlay.dispose();
    await expect(found).rejects.toThrow(/disposed/);
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

    view.answer({
      url: note.url,
      cloneUrl: clone.url,
      scratchUrl: computed.url,
    });
    await vi.waitFor(() => expect(handle.doc().title).toBe("laid"));
  });

  it("shows a pinned url at heads only the scratch document has from the scratch one", async () => {
    const scratchDoc = fork();
    scratchDoc.change((d) => {
      d.title = "laid";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const live = await view.overlay.find<Note>(note.url);

    const pinned = stringifyAutomergeUrl({
      documentId: note.documentId,
      heads: live.heads(),
    });
    const old = await view.overlay.find<Note>(pinned);
    expect(old.url).toBe(pinned);
    expect(old.doc().title).toBe("laid");
    expect(view.leases(scratchDoc.url)).toBe(2);
  });

  it("resolves a view() of a scratch backing back through the overlay", async () => {
    const scratchDoc = fork();
    scratchDoc.change((d) => {
      d.title = "laid";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const live = await view.overlay.find<Note>(note.url);

    const snapshot = live.view(live.heads());
    expect(snapshot.url).toBe(
      stringifyAutomergeUrl({
        documentId: note.documentId,
        heads: live.heads(),
      })
    );
    const roundTrip = await view.overlay.find<Note>(snapshot.url);
    expect(roundTrip.doc().title).toBe("laid");
  });
});

describe("scratch backings: peer traffic", () => {
  const peer = "peer-1" as PeerId;

  // Every ephemeral message `handles` hear, with whether it came stamped
  // with the handle that heard it.
  function hear(...handles: DocHandle<unknown>[]) {
    const heard: [number, boolean, unknown][] = [];
    handles.forEach((h, i) =>
      h.on("ephemeral-message", ({ handle, message }) =>
        heard.push([i, handle === h, message])
      )
    );
    return heard;
  }

  it("sends and hears ephemeral messages through the stored document", async () => {
    const scratchDoc = fork();
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    const title = handle.sub("title");

    const heard = hear(handle, title);
    note._receiveInboundEphemeral(peer, "stored");
    scratchDoc._receiveInboundEphemeral(peer, "scratch");
    expect(heard).toEqual([
      [0, true, "stored"],
      [1, true, "stored"],
    ]);

    const sent: string[] = [];
    note.on("ephemeral-message-outbound", () => sent.push("stored"));
    scratchDoc.on("ephemeral-message-outbound", () => sent.push("scratch"));
    handle.broadcast({ hello: 1 });
    title.broadcast({ hello: 2 });
    expect(sent).toEqual(["stored", "stored"]);
  });

  it("goes through the clone under a scratch document laid over one", async () => {
    const clone = repo.clone(note);
    const scratchDoc = scratch.create<Note>();
    scratchDoc.update(() => A.clone(clone.doc()));
    const view = mount();
    view.answer({
      url: note.url,
      cloneUrl: clone.url,
      scratchUrl: scratchDoc.url,
    });
    const handle = await view.overlay.find<Note>(note.url);

    const heard = hear(handle);
    note._receiveInboundEphemeral(peer, "note");
    clone._receiveInboundEphemeral(peer, "clone");
    scratchDoc._receiveInboundEphemeral(peer, "scratch");
    expect(heard).toEqual([[0, true, "clone"]]);
  });

  it("hears remote heads on the live root alone, as the repo emits them", async () => {
    const scratchDoc = fork();
    scratchDoc.change((d) => {
      d.title = "laid";
    });
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const live = await view.overlay.find<Note>(note.url);
    const pinned = await view.overlay.find<Note>(
      stringifyAutomergeUrl({
        documentId: note.documentId,
        heads: live.heads(),
      })
    );
    const title = live.sub("title");

    const heard: string[] = [];
    live.on("remote-heads", () => heard.push("live"));
    pinned.on("remote-heads", () => heard.push("pinned"));
    title.on("remote-heads", () => heard.push("title"));
    note.emit("remote-heads", {
      storageId: "server" as never,
      heads: note.heads(),
      timestamp: 1,
    });
    expect(heard).toEqual(["live"]);
    // The pinned view's other peer traffic is the stored document's too.
    const messages = hear(pinned);
    note._receiveInboundEphemeral(peer, "stored");
    expect(messages).toEqual([[0, true, "stored"]]);
  });

  it("moves with the backing, and lets go of the stored document's handle", async () => {
    const first = fork();
    const second = fork();
    const clone = repo.clone(note);
    const before = note.listenerCount("ephemeral-message");
    const view = mount();
    view.answer({ url: note.url, scratchUrl: first.url });
    const handle = await view.overlay.find<Note>(note.url);
    const title = handle.sub("title");
    const heard = hear(handle, title);
    // One forwarder each, both on the stored document's root.
    expect(note.listenerCount("ephemeral-message")).toBe(before + 2);

    // Another scratch document over the same stored one: nothing moves.
    view.answer({ url: note.url, scratchUrl: second.url });
    await backedBy(handle, second);
    expect(note.listenerCount("ephemeral-message")).toBe(before + 2);
    note._receiveInboundEphemeral(peer, "stored");
    expect(heard.splice(0)).toEqual([
      [0, true, "stored"],
      [1, true, "stored"],
    ]);

    // A clone with no scratch document: its own peers.
    view.answer({ url: note.url, cloneUrl: clone.url });
    await backedBy(handle, clone);
    expect(note.listenerCount("ephemeral-message")).toBe(before);
    note._receiveInboundEphemeral(peer, "stored");
    second._receiveInboundEphemeral(peer, "scratch");
    clone._receiveInboundEphemeral(peer, "clone");
    expect(heard.splice(0)).toEqual([
      [0, true, "clone"],
      [1, true, "clone"],
    ]);

    view.overlay.dispose();
    expect(clone.listenerCount("ephemeral-message")).toBe(0);
    clone._receiveInboundEphemeral(peer, "after");
    expect(heard).toEqual([]);
  });

  // The stored document's lookup, held back until `found()`.
  function holdStoredLookup() {
    let found!: () => void;
    const ready = new Promise<DocHandle<unknown>>((resolve) => {
      found = () => resolve(note as DocHandle<unknown>);
    });
    const real = repo.findWithProgress.bind(repo);
    const spy = vi.spyOn(repo, "findWithProgress").mockImplementation(((
      id: AutomergeUrl
    ) =>
      id === note.url
        ? {
            ...real(id),
            peek: () => ({ state: "loading", sources: {} }),
            whenReady: () => ready,
          }
        : real(id)) as typeof repo.findWithProgress);
    teardowns.push(() => spy.mockRestore());
    return found;
  }

  it("moves peer traffic to the stored document once it's found", async () => {
    const found = holdStoredLookup();
    const scratchDoc = fork();
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    const title = handle.sub("title");
    const heard = hear(handle, title);

    scratchDoc._receiveInboundEphemeral(peer, "scratch");
    expect(heard.splice(0)).toEqual([
      [0, true, "scratch"],
      [1, true, "scratch"],
    ]);

    found();
    await vi.waitFor(() =>
      expect(note.listenerCount("ephemeral-message")).toBeGreaterThan(0)
    );
    scratchDoc._receiveInboundEphemeral(peer, "scratch");
    note._receiveInboundEphemeral(peer, "stored");
    expect(heard).toEqual([
      [0, true, "stored"],
      [1, true, "stored"],
    ]);
  });

  it("ignores a stored document found after the backing has moved on", async () => {
    const found = holdStoredLookup();
    const scratchDoc = fork();
    const clone = repo.clone(note);
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    const heard = hear(handle);

    view.answer({ url: note.url, cloneUrl: clone.url });
    await backedBy(handle, clone);
    found();
    await new Promise((resolve) => setTimeout(resolve, 10));
    note._receiveInboundEphemeral(peer, "stored");
    clone._receiveInboundEphemeral(peer, "clone");
    expect(heard).toEqual([[0, true, "clone"]]);
  });

  it("follows a new stored document under the same scratch one", async () => {
    const scratchDoc = fork();
    const clone = repo.clone(note);
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    const heard = hear(handle);

    view.answer({ url: note.url, cloneUrl: clone.url, scratchUrl: scratchDoc.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    note._receiveInboundEphemeral(peer, "stored");
    clone._receiveInboundEphemeral(peer, "clone");
    expect(heard).toEqual([[0, true, "clone"]]);
  });

  // A stored document that never turns up; says what the wait for it was
  // told to stop on.
  function holdStoredForever() {
    const waits: (AbortSignal | undefined)[] = [];
    const real = repo.findWithProgress.bind(repo);
    const spy = vi.spyOn(repo, "findWithProgress").mockImplementation(((
      id: AutomergeUrl
    ) =>
      id === note.url
        ? {
            ...real(id),
            peek: () => ({ state: "loading", sources: {} }),
            whenReady: (options?: { signal?: AbortSignal }) => {
              waits.push(options?.signal);
              return new Promise(() => {});
            },
          }
        : real(id)) as typeof repo.findWithProgress);
    teardowns.push(() => spy.mockRestore());
    return waits;
  }

  it("stops waiting for the stored document when the backing moves on", async () => {
    const waits = holdStoredForever();
    const scratchDoc = fork();
    const clone = repo.clone(note);
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    const handle = await view.overlay.find<Note>(note.url);
    expect(waits.map((signal) => signal?.aborted)).toEqual([false]);

    view.answer({ url: note.url, cloneUrl: clone.url });
    await backedBy(handle, clone);
    expect(waits.map((signal) => signal?.aborted)).toEqual([true]);
  });

  it("stops waiting for the stored document on dispose", async () => {
    const waits = holdStoredForever();
    const scratchDoc = fork();
    const view = mount();
    view.answer({ url: note.url, scratchUrl: scratchDoc.url });
    await view.overlay.find<Note>(note.url);

    view.overlay.dispose();
    expect(waits.map((signal) => signal?.aborted)).toEqual([true]);
  });

  it("stays on the scratch document when the stored one can't be found", async () => {
    const scratchDoc = fork();
    const view = mount();
    view.answer({
      url: note.url,
      cloneUrl: generateAutomergeUrl(),
      scratchUrl: scratchDoc.url,
    });
    const handle = await view.overlay.find<Note>(note.url);
    expect(handle.doc().title).toBe("note");
    const heard = hear(handle);
    await new Promise((resolve) => setTimeout(resolve, 20));
    scratchDoc._receiveInboundEphemeral(peer, "scratch");
    expect(heard).toEqual([[0, true, "scratch"]]);
  });
});
